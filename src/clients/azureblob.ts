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
    BlobServiceClient,
    ContainerClient,
    StorageSharedKeyCredential,
} from '@azure/storage-blob';
import * as Crypto from 'crypto';
import * as deploy_clients from '../clients';
import * as deploy_files from '../files';
import * as deploy_helpers from '../helpers';
import * as MimeTypes from 'mime-types';
import * as Moment from 'moment';
import * as Path from 'path';


/**
 * Options for accessing an Azure blob storage.
 */
export interface AzureBlobOptions {
    /**
     * The access key.
     */
    readonly accessKey?: string;
    /**
     * The account name.
     */
    readonly account?: string;
    /**
     * The container name.
     */
    readonly container?: string;
    /**
     * Hash content or not.
     */
    readonly hashContent?: boolean;
    /**
     * The custom host address.
     */
    readonly host?: string;
    /**
     * Use local development storage or not.
     */
    readonly useDevelopmentStorage?: boolean;
}


/**
 * An Azure blob client.
 */
export class AzureBlobClient extends deploy_clients.AsyncFileListBase {
    /**
     * Initializes a new instance of that class.
     * 
     * @param {AzureBlobOptions} options The options.
     */
    constructor(public readonly options: AzureBlobOptions) {
        super();
    }

    /**
     * Gets the container name,
     */
    public get container(): string {
        let normalizedContainer = deploy_helpers.normalizeString(this.options.container);
        if ('' === normalizedContainer) {
            normalizedContainer = 'vscode-deploy-reloaded';
        }

        return normalizedContainer;
    }

    private createInstance(): ContainerClient {
        let serviceClient: BlobServiceClient;

        if (deploy_helpers.toBooleanSafe(this.options.useDevelopmentStorage)) {
            serviceClient = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true');
        }
        else {
            const ACCOUNT = deploy_helpers.toStringSafe(this.options.account).trim();
            const ACCESS_KEY = deploy_helpers.toStringSafe(this.options.accessKey).trim();

            const HOST = deploy_helpers.normalizeString(this.options.host);
            const URL = ('' !== HOST) ? HOST
                                      : `https://${ ACCOUNT }.blob.core.windows.net`;

            serviceClient = new BlobServiceClient(
                URL,
                new StorageSharedKeyCredential(ACCOUNT, ACCESS_KEY),
            );
        }

        return serviceClient.getContainerClient(this.container);
    }

    /** @inheritdoc */
    public deleteFile(path: string): Promise<boolean> {
        const ME = this;

        path = toAzurePath(path);
        
        return new Promise<boolean>(async (resolve, reject) => {
            const COMPLETED = deploy_helpers.createCompletedAction(resolve, reject);

            try {
                const CONTAINER = ME.createInstance();

                try {
                    await CONTAINER.deleteBlob(path);

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

        path = toAzurePath(path);

        return new Promise<Buffer>(async (resolve, reject) => {
            const COMPLETED = deploy_helpers.createCompletedAction(resolve, reject);

            try {
                const CONTAINER = ME.createInstance();

                const DOWNLOADED_DATA = await CONTAINER.getBlobClient(path)
                                                       .downloadToBuffer();

                COMPLETED(null, DOWNLOADED_DATA);
            }
            catch (e) {
                COMPLETED(e);
            }
        });
    }

    /** @inheritdoc */
    public async listDirectory(path: string): Promise<deploy_files.FileSystemInfo[]> {
        const ME = this;

        path = toAzurePath(path);

        return new Promise<deploy_files.FileSystemInfo[]>(async (resolve, reject) => {
            const COMPLETED = deploy_helpers.createCompletedAction(resolve, reject);

            const ALL_RESULTS: any[] = [];
            const ITEMS: deploy_files.FileSystemInfo[] = [];
            const ALL_LOADED = () => {
                const DIRS_ALREADY_ADDED: { [ dir: string ]: deploy_files.DirectoryInfo } = {};
                for (const R of ALL_RESULTS) {
                    const NAME = deploy_helpers.toStringSafe(R.name);
                    const NAME_WITHOUT_PATH = deploy_helpers.normalizePath( NAME.substr(path.length) );

                    if (NAME_WITHOUT_PATH.indexOf('/') > -1) {
                        // directory

                        const DIR = NAME_WITHOUT_PATH.split('/')[0];

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
                                    path + '/' + NAME_WITHOUT_PATH
                                );
                            },
                            //TODO: exportPath: false,
                            name: NAME_WITHOUT_PATH,
                            path: path,
                            size: parseInt( deploy_helpers.toStringSafe(R.contentLength).trim() ),
                            type: deploy_files.FileSystemType.File,
                        };

                        if (!deploy_helpers.isEmptyString(R.lastModified)) {
                            (<any>FI).time = Moment(R.lastModified);
                        }

                        ITEMS.push(FI);
                    }
                }

                COMPLETED(null, ITEMS);
            };

            try {
                const CONTAINER = ME.createInstance();

                // listBlobsFlat() async-iterates and handles pagination internally.
                for await (const BLOB of CONTAINER.listBlobsFlat()) {
                    ALL_RESULTS.push({
                        name: BLOB.name,
                        contentLength: BLOB.properties.contentLength,
                        lastModified: BLOB.properties.lastModified,
                    });
                }

                ALL_LOADED();
            }
            catch (e) {
                COMPLETED(e);
            }
        });
    }

    /** @inheritdoc */
    public get type(): string {
        return 'azureblob';
    }

    /** @inheritdoc */
    public uploadFile(path: string, data: Buffer): Promise<void> {
        const ME = this;

        path = toAzurePath(path);

        if (!data) {
            data = Buffer.alloc(0);
        }
        
        return new Promise<void>(async (resolve, reject) => {
            const COMPLETED = deploy_helpers.createCompletedAction(resolve, reject);

            try {
                const CONTAINER = ME.createInstance();

                let contentType = MimeTypes.lookup( Path.basename(path) );
                if (false === contentType) {
                    contentType = 'application/octet-stream';
                }

                const BLOB_HEADERS: any = {
                    blobContentType: contentType,
                };
                if (deploy_helpers.toBooleanSafe(ME.options.hashContent)) {
                    // v3 expects the raw MD5 digest bytes (not a base64 string)
                    BLOB_HEADERS.blobContentMD5 = Crypto.createHash('md5').update(data).digest();
                }

                await CONTAINER.getBlockBlobClient(path).upload(
                    data,
                    data.length,
                    {
                        blobHTTPHeaders: BLOB_HEADERS,
                    },
                );

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
 * @param {AzureBlobOptions} opts The options.
 * 
 * @return {AzureBlobClient} The new client.
 */
export function createClient(opts: AzureBlobOptions): AzureBlobClient {
    if (!opts) {
        opts = <any>{};
    }

    return new AzureBlobClient(opts);
}

/**
 * Converts to an Azure path.
 * 
 * @param {string} path The path to convert.
 * 
 * @return {string} The converted path. 
 */
export function toAzurePath(path: string) {
    return deploy_helpers.normalizePath(path);
}
