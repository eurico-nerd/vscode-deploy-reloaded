/**
 * This file is part of the vscode-deploy-reloaded distribution.
 * Copyright (c) Marcel Joachim Kloubert.
 *
 * vscode-deploy-reloaded is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as
 * published by the Free Software Foundation, version 3.
 *
 * vscode-deploy-reloaded is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

import {
    DeleteObjectCommand,
    GetObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import {
    fromCognitoIdentityPool,
    fromContainerMetadata,
    fromEnv,
    fromIni,
    fromInstanceMetadata,
    fromTemporaryCredentials,
    fromWebToken,
} from '@aws-sdk/credential-providers';
import * as deploy_clients from '../clients';
import * as deploy_files from '../files';
import * as deploy_helpers from '../helpers';
import * as deploy_values from '../values';
import * as Enumerable from 'node-enumerable';
import * as i18 from '../i18';
import * as MimeTypes from 'mime-types';
import * as OS from 'os';
import * as Path from 'path';
import * as Moment from 'moment';


/**
 * A function that detects the ACL for a file when uploading it.
 *
 * @param {string} file The path of the file inside the bucket.
 * @param {string} defaultAcl The default ACL of the bucket.
 *
 * @return {string} The ACL.
 */
export type S3BucketFileAclDetector = (file: string, defaultAcl: string) => string;

/**
 * Options for accessing a S3 bucket.
 */
export interface S3BucketOptions {
    /**
     * The default ACL to set.
     */
    readonly acl?: string;
    /**
     * The name of the bucket.
     */
    readonly bucket: string;
    /**
     * Credential settings.
     */
    readonly credentials?: {
        /**
         * Configuration data for the credential provider.
         */
        readonly config?: any;
        /**
         * The credential provider / type.
         */
        readonly type?: string;
    };
    /**
     * A custom function that provides scopes directories for relative paths.
     */
    readonly directoryScopeProvider?: S3DirectoryScopeProvider;
    /**
     * A function that detects the ACL for a file
     * when uploading it.
     */
    readonly fileAcl?: S3BucketFileAclDetector;
    /**
     * A function that provides values for a client.
     */
    readonly valueProvider?: S3ValueProvider;
    /**
     * Custom options.
     */
    readonly customOpts?: object;
}

/**
 * A function that provides the scope directories for relative paths.
 */
export type S3DirectoryScopeProvider = () => string | string[] | PromiseLike<string | string[]>;

/**
 * A function that provides values for use in settings for a client.
 */
export type S3ValueProvider = () => deploy_values.Value | deploy_values.Value[] | PromiseLike<deploy_values.Value | deploy_values.Value[]>;

interface SharedIniFileCredentialsOptions {
    profile?: string;
    filename?: string;
    disableAssumeRole?: boolean;
}


/**
 * The default ACL for a file.
 */
export const DEFAULT_ACL = 'public-read';

/**
 * Builds an AWS SDK v3 credential provider from a legacy credential type and
 * its (already pre-processed) config. Returns a provider/credentials object.
 *
 * Note: the legacy 'saml' type (SAMLCredentials) has no AWS SDK v3 equivalent
 * and is reported as unsupported. The legacy 'file' type (FileSystemCredentials)
 * is implemented by reading a JSON credentials file.
 */
async function buildAwsCredentials(type: string, config: any): Promise<any> {
    switch (deploy_helpers.normalizeString(type)) {
        case '':
        case 'shared':
            {
                let profile: string;
                let filepath: string;
                if (deploy_helpers.isObject(config)) {
                    profile = deploy_helpers.toStringSafe((<any>config).profile);
                    filepath = deploy_helpers.toStringSafe((<any>config).filename);
                }
                else {
                    profile = deploy_helpers.toStringSafe(config);
                }

                return fromIni({
                    profile: deploy_helpers.isEmptyString(profile) ? undefined : profile,
                    filepath: deploy_helpers.isEmptyString(filepath) ? undefined : filepath,
                });
            }

        case 'environment':
            return fromEnv();

        case 'ec2meta':
            return fromInstanceMetadata();

        case 'ec2':
            return fromContainerMetadata();

        case 'temp':
            return fromTemporaryCredentials(config || <any>{});

        case 'web':
            return fromWebToken(config || <any>{});

        case 'cognito':
            return fromCognitoIdentityPool(config || <any>{});

        case 'file':
            {
                // legacy FileSystemCredentials: a JSON file with the credentials
                const RAW = await deploy_helpers.readFile(deploy_helpers.toStringSafe(config));
                const JSON_CREDS = JSON.parse(RAW.toString('utf8'));

                return {
                    accessKeyId: JSON_CREDS.accessKeyId,
                    secretAccessKey: JSON_CREDS.secretAccessKey,
                    sessionToken: JSON_CREDS.sessionToken,
                };
            }

        default:
            // e.g. 'saml' (no AWS SDK v3 equivalent)
            throw new Error(i18.t('s3bucket.credentialTypeNotSupported', type));
    }
}


/**
 * A S3 bucket file client.
 */
export class S3BucketClient extends deploy_clients.AsyncFileListBase {
    /**
     * Initializes a new instance of that class.
     *
     * @param {S3BucketOptions} options The options.
     */
    constructor(public readonly options: S3BucketOptions) {
        super();
    }

    private async createInstance(): Promise<{ s3: S3Client; bucket: string }> {
        const AWS_DIR = Path.resolve(
            Path.join(
                OS.homedir(),
                '.aws'
            )
        );

        let directoryScopeProvider = this.options.directoryScopeProvider;
        if (!directoryScopeProvider) {
            directoryScopeProvider = () => [];
        }

        const DIRECTORY_SCOPES = Enumerable.from(
            deploy_helpers.asArray(
                await Promise.resolve( directoryScopeProvider() )
            )
        ).select(s => {
            return deploy_helpers.toStringSafe(s);
        }).where(s => {
            return !deploy_helpers.isEmptyString(s);
        }).select(s => {
            if (!Path.isAbsolute(s)) {
                s = Path.join(AWS_DIR, s);
            }

            return Path.resolve(s);
        }).toArray();

        if (DIRECTORY_SCOPES.length < 1) {
            DIRECTORY_SCOPES.push( AWS_DIR );  // .aws by default
        }

        let valueProvider = this.options.valueProvider;
        if (!valueProvider) {
            valueProvider = () => [];
        }

        const VALUES = deploy_helpers.asArray(
            await Promise.resolve( valueProvider() )
        );

        const REPLACE_WITH_VALUES = (val: any) => {
            return deploy_values.replaceWithValues(
                VALUES,
                val,
            );
        };

        const FIND_FULL_FILE_PATH = async (p: string): Promise<string> => {
            p = deploy_helpers.toStringSafe(p);

            if (Path.isAbsolute(p)) {
                // exist if file exists

                if (await deploy_helpers.exists(p)) {
                    if ((await deploy_helpers.lstat(p)).isFile()) {
                        return Path.resolve(p);  // file exists
                    }
                }
            }
            else {
                // detect existing, full path
                for (const DS of DIRECTORY_SCOPES) {
                    let fullPath = REPLACE_WITH_VALUES(p);
                    fullPath = Path.join(DS, fullPath);
                    fullPath = Path.resolve(fullPath);

                    if (await deploy_helpers.exists(fullPath)) {
                        if ((await deploy_helpers.lstat(fullPath)).isFile()) {
                            return fullPath;  // file found
                        }
                    }
                }
            }

            throw new Error(i18.t('fileNotFound',
                                  p));
        };

        let bucket = deploy_helpers.toStringSafe(this.options.bucket).trim();
        if ('' === bucket) {
            bucket = 'vscode-deploy-reloaded';
        }

        let credentialConfig: any;
        let credentialType: string;
        if (this.options.credentials) {
            credentialType = deploy_helpers.normalizeString(this.options.credentials.type);

            credentialConfig = this.options.credentials.config;

            switch (credentialType) {
                case 'environment':
                    // EnvironmentCredentials
                    if (!deploy_helpers.isNullOrUndefined(credentialConfig)) {
                        credentialConfig = REPLACE_WITH_VALUES(credentialConfig).trim();
                    }
                    break;

                case 'file':
                    // FileSystemCredentials
                    if (!deploy_helpers.isNullOrUndefined(credentialConfig)) {
                        credentialConfig = deploy_helpers.toStringSafe(credentialConfig);

                        if (!deploy_helpers.isEmptyString(credentialConfig)) {
                            credentialConfig = await FIND_FULL_FILE_PATH(credentialConfig);
                        }
                    }
                    break;

                case 'shared':
                    // SharedIniFileCredentials
                    {
                        const GET_PROFILE_SAFE = (profile: any): string => {
                            profile = deploy_helpers.toStringSafe(
                                REPLACE_WITH_VALUES(profile)
                            ).trim();
                            if ('' === profile) {
                                profile = undefined;
                            }

                            return profile;
                        };

                        let sharedCfg: string | SharedIniFileCredentialsOptions = deploy_helpers.cloneObject(
                            credentialConfig
                        );
                        if (deploy_helpers.isObject<SharedIniFileCredentialsOptions>(sharedCfg)) {
                            sharedCfg.filename = deploy_helpers.toStringSafe(sharedCfg.filename);
                        }
                        else {
                            sharedCfg = {
                                profile: deploy_helpers.toStringSafe(sharedCfg),
                            };
                        }

                        if (deploy_helpers.isEmptyString(sharedCfg.filename)) {
                            sharedCfg.filename = undefined;
                        }
                        else {
                            sharedCfg.filename = await FIND_FULL_FILE_PATH(sharedCfg.filename);
                        }

                        sharedCfg.profile = GET_PROFILE_SAFE(sharedCfg.profile);

                        credentialConfig = sharedCfg;
                    }
                    break;
            }
        }

        const CREDENTIALS = await buildAwsCredentials(credentialType, credentialConfig);

        // AWS SDK v3 has no global config and requires a region. Honour any
        // region/endpoint/etc. supplied via customOpts; fall back to env vars.
        const CLIENT_CONFIG: any = Object.assign(
            {
                region: process.env.AWS_REGION ||
                        process.env.AWS_DEFAULT_REGION ||
                        'us-east-1',
            },
            this.options.customOpts || {},
        );
        if (CREDENTIALS) {
            CLIENT_CONFIG.credentials = CREDENTIALS;
        }

        return {
            s3: new S3Client(CLIENT_CONFIG),
            bucket: bucket,
        };
    }

    /** @inheritdoc */
    public deleteFile(path: string): Promise<boolean> {
        const ME = this;

        path = toS3Path(path);

        return new Promise<boolean>(async (resolve, reject) => {
            const COMPLETED = deploy_helpers.createCompletedAction(resolve, reject);

            try {
                const { s3, bucket } = await ME.createInstance();

                try {
                    await s3.send(new DeleteObjectCommand({
                        Bucket: bucket,
                        Key: path,
                    }));

                    COMPLETED(null, true);
                }
                catch (e) {
                    COMPLETED(null, false);
                }
            }
            catch (e) {
                COMPLETED(e);
            }
        });
    }

    /** @inheritdoc */
    public downloadFile(path: string): Promise<Buffer> {
        const ME = this;

        path = toS3Path(path);

        return new Promise<Buffer>(async (resolve, reject) => {
            const COMPLETED = deploy_helpers.createCompletedAction(resolve, reject);

            try {
                const { s3, bucket } = await ME.createInstance();

                const RESULT = await s3.send(new GetObjectCommand({
                    Bucket: bucket,
                    Key: path,
                }));

                // In v3 the body is a stream; collect it into a Buffer.
                const DATA = Buffer.from(
                    await (<any>RESULT.Body).transformToByteArray()
                );

                COMPLETED(null, DATA);
            }
            catch (e) {
                COMPLETED(e);
            }
        });
    }

    private getDefaultAcl() {
        return getAclSafe(this.options.acl);
    }

    /** @inheritdoc */
    public async listDirectory(path: string): Promise<deploy_files.FileSystemInfo[]> {
        const ME = this;

        path = toS3Path(path);

        return new Promise<deploy_files.FileSystemInfo[]>(async (resolve, reject) => {
            const COMPLETED = deploy_helpers.createCompletedAction(resolve, reject);

            const ALL_OBJS: any[] = [];
            const ITEMS: deploy_files.FileSystemInfo[] = [];
            const ALL_LOADED = () => {
                const DIRS_ALREADY_ADDED: { [ dir: string ]: deploy_files.DirectoryInfo } = {};
                for (const O of ALL_OBJS) {
                    const KEY = deploy_helpers.toStringSafe(O.Key);
                    const KEY_WITHOUT_PATH = deploy_helpers.normalizePath( KEY.substr(path.length) );

                    if (KEY_WITHOUT_PATH.indexOf('/') > -1) {
                        // directory

                        const DIR = KEY_WITHOUT_PATH.split('/')[0];

                        let existingDir = DIRS_ALREADY_ADDED[DIR];
                        if (!existingDir) {
                            const DI: deploy_files.DirectoryInfo = {
                                //TODO: exportPath: false,
                                name: DIR,
                                path: path,
                                type: deploy_files.FileSystemType.Directory,
                            };

                            ITEMS.push(DI);
                            existingDir = DIRS_ALREADY_ADDED[DIR] = DI;
                        }
                    }
                    else {
                        // file

                        const FI: deploy_files.FileInfo = {
                            download: async () => {
                                return await ME.downloadFile(
                                    path + '/' + KEY_WITHOUT_PATH
                                );
                            },
                            //TODO: exportPath: false,
                            name: KEY_WITHOUT_PATH,
                            path: path,
                            size: O.Size,
                            type: deploy_files.FileSystemType.File,
                        };

                        if (!deploy_helpers.isNullOrUndefined(O.LastModified)) {
                            (<any>FI).time = Moment(O.LastModified);
                        }

                        ITEMS.push(FI);
                    }
                }

                COMPLETED(null, ITEMS);
            };

            const HANDLE_RESULT = (result: any) => {
                if (!result) {
                    return;
                }

                const RESULT_OBJS = result.Contents;
                if (!RESULT_OBJS) {
                    return;
                }

                for (const O of RESULT_OBJS) {
                    if (O) {
                        ALL_OBJS.push(O);
                    }
                }
            };

            try {
                const { s3, bucket } = await ME.createInstance();

                let currentContinuationToken: string = undefined;

                do {
                    const RESULT = await s3.send(new ListObjectsV2Command({
                        Bucket: bucket,
                        ContinuationToken: currentContinuationToken,
                        Prefix: path,
                    }));

                    HANDLE_RESULT(RESULT);

                    currentContinuationToken = RESULT.IsTruncated ? RESULT.NextContinuationToken
                                                                  : undefined;
                }
                while (!deploy_helpers.isEmptyString(currentContinuationToken));

                ALL_LOADED();
            }
            catch (e) {
                COMPLETED(e);
            }
        });
    }

    /** @inheritdoc */
    public get type(): string {
        return 's3bucket';
    }

    /** @inheritdoc */
    public uploadFile(path: string, data: Buffer): Promise<void> {
        const ME = this;

        path = toS3Path(path);

        if (!data) {
            data = Buffer.alloc(0);
        }

        return new Promise<void>(async (resolve, reject) => {
            const COMPLETED = deploy_helpers.createCompletedAction(resolve, reject);

            try {
                const { s3, bucket } = await ME.createInstance();

                let contentType = MimeTypes.lookup( Path.basename(path) );
                if (false === contentType) {
                    contentType = 'application/octet-stream';
                }

                let acl: string;

                const FILE_ACL = ME.options.fileAcl;
                if (FILE_ACL) {
                    acl = FILE_ACL(path, ME.getDefaultAcl());
                }

                acl = deploy_helpers.normalizeString(acl);
                if ('' === acl) {
                    acl = undefined;
                }

                await s3.send(new PutObjectCommand({
                    ACL: <any>acl,
                    Bucket: bucket,
                    ContentType: <any>contentType,
                    Key: path,
                    Body: data,
                }));

                COMPLETED(null);
            }
            catch (e) {
                COMPLETED(e);
            }
        });
    }
}


/**
 * Creates a new client.
 *
 * @param {S3BucketOptions} opts The options.
 *
 * @return {S3BucketClient} The new client.
 */
export function createClient(opts: S3BucketOptions): S3BucketClient {
    if (!opts) {
        opts = <any>{};
    }

    return new S3BucketClient(opts);
}

/**
 * Returns the name of an ACL safe.
 *
 * @param {string} acl The input value.
 *
 * @return {string} The normalized, safe value.
 */
export function getAclSafe(acl: string) {
    acl = deploy_helpers.normalizeString(acl);
    if ('' === acl) {
        acl = DEFAULT_ACL;
    }

    return acl;
}

/**
 * Converts to a S3 path.
 *
 * @param {string} path The path to convert.
 *
 * @return {string} The converted path.
 */
export function toS3Path(path: string) {
    return deploy_helpers.normalizePath(path);
}
