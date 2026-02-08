import { App, TFile, requestUrl, RequestUrlParam } from 'obsidian';
import { SvgConverter } from './svg-converter';

// 飞书API响应接口
export interface FeishuApiResponse<T = unknown> {
    code: number;
    msg: string;
    data: T;
}

// 访问令牌响应
export interface AccessTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
}

// 导入任务创建响应
export interface ImportTaskResponse {
    ticket: string;
}

// 导入任务查询响应
export interface ImportTaskQueryResponse {
    job_status: number; // 0: 成功, 1: 进行中, 2: 失败
    job_error_msg?: string;
    token?: string; // 文档token
    url?: string; // 文档链接
}

// 上传素材响应
export interface UploadMaterialResponse {
    file_token: string;
}

// 文档块响应
export interface DocumentBlocksResponse {
    items: DocumentBlock[];
    page_token?: string;
    has_more: boolean;
}

// 文档块结构
export interface DocumentBlock {
    block_id: string;
    block_type: number; // 2: 文本, 27: 图片
    parent_id?: string;
    children?: string[];
    text?: {
        elements: TextElement[];
        style: TextStyle;
    }
    image?: {
        token?: string;
        width?: number;
        height?: number;
    };
}

// 文本元素
export interface TextElement {
    text_run?: {
        content: string;
        text_element_style?: TextStyle;
    };
}

// 图片信息结构
export interface ImageInfo {
    path: string;
    fileName: string;
    position: number;
    blockId?: string;
    width?: number;
    height?: number;
    svgConvertOptions?: {
        originalWidth: number;
        originalHeight: number;
        scale: number;
    };
}

type TextStyle = Record<string, unknown>;

type TenantAccessTokenResponse = {
    tenant_access_token?: string;
    expire?: number;
    code?: number;
    msg?: string;
};

type ImportTaskRequestBody = {
    file_extension: string;
    file_name: string;
    type: 'docx';
    file_token: string;
    point?: {
        mount_type: number;
        mount_key: string;
    };
};

type PermissionRequestBody = {
    external_access_entity: string;
    link_share_entity?: string;
    copy_entity?: string;
    security_entity?: string;
};

type ImportTaskQueryResult = ImportTaskQueryResponse | { result?: ImportTaskQueryResponse };

type MarkdownConvertResponse = {
    blocks?: unknown[];
};

type BlockUpdateRequest = {
    block_id?: string;
    parent_id?: string;
    index?: number;
    insert_block?: Record<string, unknown>;
    update_text_elements?: {
        elements: Array<{
            text_run?: {
                content: string;
                text_element_style?: TextStyle;
            };
            mention_doc?: Record<string, unknown>;
            equation?: Record<string, unknown>;
        }>;
    };
    merge_table_cells?: Record<string, unknown>;
    unmerge_table_cells?: Record<string, unknown>;
    replace_image?: Record<string, unknown>;
};

type DocumentBlockPayload = Record<string, unknown>;

type ErrorMeta = {
    status?: number;
    statusText?: string;
    response?: unknown;
    json?: unknown;
    headers?: unknown;
};

const getErrorMeta = (error: unknown): ErrorMeta => {
    if (typeof error !== 'object' || error === null) {
        return {};
    }
    const meta = error;
    const result: ErrorMeta = {};
    if ('status' in meta) {
        const status = meta.status;
        if (typeof status === 'number') {
            result.status = status;
        }
    }
    if ('statusText' in meta) {
        const statusText = meta.statusText;
        if (typeof statusText === 'string') {
            result.statusText = statusText;
        }
    }
    if ('response' in meta) {
        result.response = meta.response;
    }
    if ('json' in meta) {
        result.json = meta.json;
    }
    if ('headers' in meta) {
        result.headers = meta.headers;
    }
    return result;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const parseErrorResult = (value: unknown): { code: number; msg: string } | null => {
    if (!isRecord(value)) {
        return null;
    }
    const code = value['code'];
    const msg = value['msg'];
    if (typeof code !== 'number' || typeof msg !== 'string') {
        return null;
    }
    return { code, msg };
};

const parseTenantAccessTokenResponse = (value: unknown): TenantAccessTokenResponse => {
    const result: TenantAccessTokenResponse = {};
    if (!isRecord(value)) {
        return result;
    }
    const tenantAccessToken = value['tenant_access_token'];
    if (typeof tenantAccessToken === 'string') {
        result.tenant_access_token = tenantAccessToken;
    }
    const expire = value['expire'];
    if (typeof expire === 'number') {
        result.expire = expire;
    }
    const code = value['code'];
    if (typeof code === 'number') {
        result.code = code;
    }
    const msg = value['msg'];
    if (typeof msg === 'string') {
        result.msg = msg;
    }
    return result;
};

const getAdapterBasePath = (adapter: unknown): string | undefined => {
    if (!isRecord(adapter)) {
        return undefined;
    }
    const basePath = adapter['basePath'];
    return typeof basePath === 'string' ? basePath : undefined;
};

const isImportTaskQueryResponse = (value: unknown): value is ImportTaskQueryResponse => {
    return typeof value === 'object' && value !== null && 'job_status' in value;
};

// 飞书API客户端类
export class FeishuApiClient {
    private appId: string;
    private appSecret: string;
    private accessToken: string | null = null;
    private tokenExpireTime: number = 0;
    private app: App | undefined;
    private apiCallCountCallback: (() => void) | undefined;
    private tokenRefreshPromise: Promise<string> | null = null; // 防止并发token获取
    private static debugEnabled = false;
    
    // Mermaid图片缓存，用于存储临时生成的图片数据
    private static mermaidImageCache: Map<string, { base64Data: string; svgConvertOptions?: { originalWidth: number; originalHeight: number; scale: number } }> = new Map();
    
    // 飞书API基础URL
    private readonly baseUrl = 'https://open.feishu.cn/open-apis';
    
    // 限速相关属性
    private deleteRequestQueue: Array<() => Promise<unknown>> = [];
    private isProcessingDeleteQueue = false;
    private lastDeleteRequestTime = 0;
    private readonly DELETE_REQUEST_INTERVAL = 350; // 每次删除请求间隔350ms，确保不超过每秒3次
    
    constructor(appId: string, appSecret: string, app: App | undefined, apiCallCountCallback?: () => void) {
        this.appId = appId;
        this.appSecret = appSecret;
        this.app = app;
        this.apiCallCountCallback = apiCallCountCallback;
    }

    static setDebugEnabled(enabled: boolean): void {
        this.debugEnabled = enabled;
    }

    private debug(...args: unknown[]): void {
        if (FeishuApiClient.debugEnabled) {
            console.debug(...args);
        }
    }

    private static debug(...args: unknown[]): void {
        if (FeishuApiClient.debugEnabled) {
            console.debug(...args);
        }
    }

    private static logError(summary: string, error: unknown, details?: Record<string, unknown>): void {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(summary, errorMessage);
        FeishuApiClient.debug(`${summary} 详情:`, {
            ...details,
            error,
            errorMessage,
            errorStack: error instanceof Error ? error.stack : undefined
        });
    }

    private logError(summary: string, error: unknown, details?: Record<string, unknown>): void {
        FeishuApiClient.logError(summary, error, details);
    }
    
    /**
     * 处理删除请求队列，确保不超过频率限制
     */
    private async processDeleteQueue(): Promise<void> {
        if (this.isProcessingDeleteQueue || this.deleteRequestQueue.length === 0) {
            return;
        }
        
        this.isProcessingDeleteQueue = true;
        
        while (this.deleteRequestQueue.length > 0) {
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastDeleteRequestTime;
            
            // 如果距离上次请求时间不足间隔时间，则等待
            if (timeSinceLastRequest < this.DELETE_REQUEST_INTERVAL) {
                const waitTime = this.DELETE_REQUEST_INTERVAL - timeSinceLastRequest;
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
            
            const request = this.deleteRequestQueue.shift();
            if (request) {
                this.lastDeleteRequestTime = Date.now();
                try {
                    await request();
                } catch (error) {
                    this.logError('[飞书API] 删除请求执行失败:', error);
                    throw error;
                }
            }
        }
        
        this.isProcessingDeleteQueue = false;
    }
    
    /**
     * 将删除请求添加到队列中
     */
    private async queueDeleteRequest<T>(request: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            const wrappedRequest = async () => {
                try {
                    const result = await request();
                    resolve(result);
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            };
            
            this.deleteRequestQueue.push(wrappedRequest);
            void this.processDeleteQueue().catch(error => {
                reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
    }
    
    /**
     * 获取访问令牌
     */
    async getAccessToken(): Promise<string> {
        // 检查token是否还有效（提前30分钟刷新，符合飞书API最佳实践）
        const now = Date.now();
        if (this.accessToken && now < this.tokenExpireTime - 30 * 60 * 1000) {
            return this.accessToken;
        }
        
        // 如果已经有正在进行的token刷新请求，等待它完成
        if (this.tokenRefreshPromise) {
            return await this.tokenRefreshPromise;
        }
        
        // 创建新的token刷新Promise
        this.tokenRefreshPromise = this.performTokenRefresh();
        
        try {
            const token = await this.tokenRefreshPromise;
            return token;
        } finally {
            // 清除Promise引用，允许下次刷新
            this.tokenRefreshPromise = null;
        }
    }
    
    /**
     * 执行实际的token刷新操作
     */
    private async performTokenRefresh(): Promise<string> {
        const now = Date.now();
        const url = `${this.baseUrl}/auth/v3/tenant_access_token/internal`;
        const requestParam: RequestUrlParam = {
            url,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify({
                app_id: this.appId,
                app_secret: this.appSecret
            })
        };
        
        try {
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            this.apiCallCountCallback?.();
            
            const result = parseTenantAccessTokenResponse(response.json);
            
            // 详细检查响应结构 - 飞书API直接返回tenant_access_token字段
            if (!result.tenant_access_token) {
                console.error('[飞书API] 响应中缺少tenant_access_token字段');
                this.debug('[飞书API] 响应中缺少tenant_access_token字段，完整响应:', result);
                throw new Error(`API响应格式错误: 缺少tenant_access_token字段`);
            }
            
            if (result.code !== 0) {
                throw new Error(`获取访问令牌失败: ${result.msg}`);
            }
            
            this.accessToken = result.tenant_access_token;
            // 设置过期时间（使用完整的有效期，通过30分钟提前刷新策略管理）
            this.tokenExpireTime = now + (result.expire || 0) * 1000;
            
            return result.tenant_access_token;
        } catch (error) {
            this.logError('[飞书API] 获取访问令牌失败:', error);
            
            // 详细的错误分析
            if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
                console.error('[飞书API] 网络连接失败');
                this.debug('[飞书API] 网络连接错误，可能原因:');
                this.debug('1. 网络连接不稳定或断开');
                this.debug('2. 防火墙或代理阻止了请求');
                this.debug('3. 飞书API服务暂时不可用');
                this.debug('4. DNS解析问题');
                throw new Error('网络连接失败，请检查网络连接后重试');
            }
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`获取访问令牌失败: ${errorMessage}`);
        }
    }
    
    /**
     * 上传文件到飞书云空间
     * 使用 drive/v1/files/upload_all 接口将文件上传到飞书云空间
     * @param fileName 文件名（需包含扩展名）
     * @param fileContent 文件内容（base64编码）
     * @param folderToken 目标文件夹token（可选）
     * @returns 返回上传后的文件token
     */
    async uploadFile(fileName: string, fileContent: string, folderToken?: string): Promise<string> {
        const token = await this.getAccessToken();
        const url = `https://open.feishu.cn/open-apis/drive/v1/files/upload_all`;
        
        // 将base64内容转换为二进制数据
        const binaryData = Uint8Array.from(atob(fileContent), c => c.charCodeAt(0));
        
        // 生成随机边界字符串
        const boundary = 'feishu-file-boundary-' + Math.random().toString(36).substring(2, 15);
        
        // 手动构造multipart/form-data请求体
        const encoder = new TextEncoder();
        const parts: Uint8Array[] = [];
        
        // 添加file_name字段
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="file_name"\r\n\r\n`));
        parts.push(encoder.encode(`${fileName}\r\n`));
        
        // 添加parent_type字段
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="parent_type"\r\n\r\n`));
        parts.push(encoder.encode(`explorer\r\n`));
        
        // 如果提供了文件夹token，添加parent_node字段
        if (folderToken) {
            parts.push(encoder.encode(`--${boundary}\r\n`));
            parts.push(encoder.encode(`Content-Disposition: form-data; name="parent_node"\r\n\r\n`));
            parts.push(encoder.encode(`${folderToken}\r\n`));
        }
        
        // 添加size字段
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="size"\r\n\r\n`));
        parts.push(encoder.encode(`${binaryData.length.toString()}\r\n`));
        
        // 添加文件内容字段
        parts.push(encoder.encode(`--${boundary}\r\n`));
        // 移除文件扩展名，只保留文件名
        const fileNameWithoutExt = fileName.replace(/\.[^/.]+$/, '');
        parts.push(encoder.encode(`Content-Disposition: form-data; name="file"; filename="${fileNameWithoutExt}"\r\n`));
        parts.push(encoder.encode(`Content-Type: application/octet-stream\r\n\r\n`));
        parts.push(binaryData);
        parts.push(encoder.encode(`\r\n`));
        
        // 结束边界
        parts.push(encoder.encode(`--${boundary}--\r\n`));
        
        // 计算总长度并合并所有部分
        const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
        const body = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of parts) {
            body.set(part, offset);
            offset += part.length;
        }
        
        const requestParam: RequestUrlParam = {
            url,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: body.buffer
        };
        
        try {
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            this.apiCallCountCallback?.();
            const result: FeishuApiResponse<UploadMaterialResponse> = response.json;
            
            if (result.code !== 0) {
                console.error('[飞书API] 上传文件失败:', result.msg);
                this.debug('[飞书API] 上传文件失败，错误详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`上传文件失败: [${result.code}] ${result.msg}`);
            }
            
            if (!result.data || !result.data.file_token) {
                console.error('[飞书API] 响应中缺少file_token');
                this.debug('[飞书API] 响应中缺少file_token:', result);
                throw new Error('上传成功但未返回file_token');
            }
            
            return result.data.file_token;
        } catch (error) {
            this.logError('[飞书API] 上传文件到飞书失败:', error, {
                requestUrl: url,
                hasToken: !!token
            });
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`上传文件失败: ${errorMessage}`);
        }
    }

    /**
     * 上传图片素材到飞书云文档
     * 使用 drive/v1/medias/upload_all 接口将图片素材上传到指定云文档中
     * @param fileName 图片文件名（需包含扩展名）
     * @param fileContent 图片文件内容（base64编码）
     * @param documentId 目标飞书文档的document_id
     * @param blockId 目标图片块的block_id
     * @returns 返回上传后的文件token
     */
    async uploadImageMaterial(fileName: string, fileContent: string, documentId: string, blockId: string): Promise<string> {
        const token = await this.getAccessToken();
        const url = `https://open.feishu.cn/open-apis/drive/v1/medias/upload_all`;
        
        // 将base64内容转换为二进制数据
        const binaryData = Uint8Array.from(atob(fileContent), c => c.charCodeAt(0));
        
        // 生成随机边界字符串
        const boundary = 'feishu-image-boundary-' + Math.random().toString(36).substring(2, 15);
        
        // 手动构造multipart/form-data请求体
        const encoder = new TextEncoder();
        const parts: Uint8Array[] = [];
        
        // 添加file_name字段
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="file_name"\r\n\r\n`));
        parts.push(encoder.encode(`${fileName}\r\n`));
        
        // 添加parent_type字段（docx_image表示上传为新版文档图片）
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="parent_type"\r\n\r\n`));
        parts.push(encoder.encode(`docx_image\r\n`));
        
        // 添加parent_node字段（目标图片块的block_id）
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="parent_node"\r\n\r\n`));
        parts.push(encoder.encode(`${blockId}\r\n`));
        
        // 添加size字段
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="size"\r\n\r\n`));
        parts.push(encoder.encode(`${binaryData.length.toString()}\r\n`));
        
        // 添加extra字段 - 素材所在云文档的token
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="extra"\r\n\r\n`));
        const extraData = JSON.stringify({"drive_route_token": documentId});
        parts.push(encoder.encode(`${extraData}\r\n`));
        
        // 添加文件内容字段
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`));
        parts.push(encoder.encode(`Content-Type: application/octet-stream\r\n\r\n`));
        parts.push(binaryData);
        parts.push(encoder.encode(`\r\n`));
        
        // 结束边界
        parts.push(encoder.encode(`--${boundary}--\r\n`));
        
        // 计算总长度并合并所有部分
        const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
        const body = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of parts) {
            body.set(part, offset);
            offset += part.length;
        }
        
        const requestParam: RequestUrlParam = {
            url,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: body.buffer
        };
        
        try {
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            this.apiCallCountCallback?.();
            
            const result: FeishuApiResponse<UploadMaterialResponse> = response.json;
            
            if (result.code !== 0) {
                console.error('[飞书API] 上传图片素材失败:', result.msg);
                this.debug('[飞书API] 上传图片素材失败，错误详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`上传图片素材失败: [${result.code}] ${result.msg}`);
            }
            
            if (!result.data || !result.data.file_token) {
                console.error('[飞书API] 响应中缺少file_token');
                this.debug('[飞书API] 响应中缺少file_token:', result);
                throw new Error('上传成功但未返回file_token');
            }
            
            return result.data.file_token;
        } catch (error) {
            this.logError('[飞书API] 上传图片素材到飞书失败:', error, {
                requestUrl: url,
                hasToken: !!token
            });
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`上传图片素材失败: ${errorMessage}`);
        }
    }
    
    /**
     * 创建导入任务
     * @param fileName 文件名
     * @param fileToken 文件token（从上传文件接口获取）
     * @param folderToken 目标文件夹token（可选）
     */
    async createImportTask(fileName: string, fileToken: string, folderToken?: string): Promise<string> {
        const token = await this.getAccessToken();
        const url = `${this.baseUrl}/drive/v1/import_tasks`;
        
        // 根据飞书API文档，确保文件名和扩展名的一致性
        // 如果fileName包含扩展名，需要分离文件名和扩展名
        const lastDotIndex = fileName.lastIndexOf('.');
        let pureFileName: string;
        let fileExtension: string;
        
        if (lastDotIndex > 0 && fileName.substring(lastDotIndex + 1).toLowerCase() === 'md') {
            // 如果文件名包含.md扩展名，分离它们
            pureFileName = fileName.substring(0, lastDotIndex);
            fileExtension = 'md';
        } else {
            // 如果文件名不包含扩展名，直接使用
            pureFileName = fileName;
            fileExtension = 'md';
        }
        
        const requestBody: ImportTaskRequestBody = {
            file_extension: fileExtension, // Markdown文件扩展名
            file_name: pureFileName, // 纯文件名（不含扩展名）
            type: 'docx', // 导入为飞书文档
            file_token: fileToken
        };
        
        // 根据飞书API文档，使用point参数而不是folder_token
        if (folderToken) {
            requestBody.point = {
                mount_type: 1, // 1表示文件夹
                mount_key: folderToken
            };
        }
        
        const requestParam: RequestUrlParam = {
            url,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify(requestBody)
        };
        
        try {
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            this.apiCallCountCallback?.();
            
            const result: FeishuApiResponse<ImportTaskResponse> = response.json;
            
            // 飞书API返回code==0表示成功
            if (result.code === 0) {
                if (!result.data?.ticket) {
                    console.error('[飞书API] 创建导入任务成功但缺少ticket');
                    throw new Error('创建导入任务成功但返回数据中缺少ticket');
                }
                
                return result.data.ticket;
            } else {
                console.error('[飞书API] 创建导入任务失败:', result.msg);
                this.debug('[飞书API] 创建导入任务失败，错误详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`创建导入任务失败 (错误码: ${result.code}): ${result.msg}`);
            }
        } catch (error: unknown) {
            // 如果是HTTP错误，尝试获取响应体中的详细错误信息
            const errorMeta = getErrorMeta(error);
            if (errorMeta.status === 400 && errorMeta.json) {
                console.error('[飞书API] 创建导入任务失败 (HTTP 400)');
                this.debug('[飞书API] HTTP 400错误，详细响应:', {
                    status: errorMeta.status,
                    responseBody: errorMeta.json,
                    headers: errorMeta.headers
                });
                const errorResult = parseErrorResult(errorMeta.json);
                if (errorResult) {
                    throw new Error(`创建导入任务失败 (错误码: ${errorResult.code}): ${errorResult.msg}`);
                }
            }
            
            this.logError('[飞书API] 创建飞书导入任务失败:', error, {
                requestUrl: url,
                hasToken: !!token,
                status: errorMeta.status || 'unknown',
                responseBody: errorMeta.json || 'no response body'
            });
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`创建导入任务失败: ${errorMessage}`);
        }
    }
    
    /**
     * 查询导入任务状态
     * @param ticket 任务票据
     */
    async queryImportTask(ticket: string): Promise<ImportTaskQueryResponse> {
        const token = await this.getAccessToken();
        const url = `${this.baseUrl}/drive/v1/import_tasks/${ticket}`;
        
        const requestParam: RequestUrlParam = {
            url,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json; charset=utf-8'
            }
        };
        
        try {
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            this.apiCallCountCallback?.();
            const result: FeishuApiResponse<ImportTaskQueryResult> = response.json;
            
            if (result.code !== 0) {
                console.error('[飞书API] 查询导入任务失败:', result.msg);
                this.debug('[飞书API] 查询导入任务失败，错误详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`查询导入任务失败: [${result.code}] ${result.msg}`);
            }
            
            // 根据实际返回的数据结构解析结果
            // 飞书API返回的数据结构是 data.result，而不是直接的 data
            let taskResult: ImportTaskQueryResponse | undefined;
            if (typeof result.data === 'object' && result.data !== null && 'result' in result.data) {
                taskResult = result.data.result;
            } else if (isImportTaskQueryResponse(result.data)) {
                taskResult = result.data;
            }
            
            if (!taskResult) {
                throw new Error('导入任务结果为空');
            }
            
            return taskResult;
        } catch (error) {
            this.logError('[飞书API] 查询导入任务异常:', error, {
                requestUrl: url,
                hasToken: !!token
            });
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`查询导入任务失败: ${errorMessage}`);
        }
    }
    
    /**
     * 等待导入任务完成（支持递增重试间隔）
     * @param ticket 任务票据
     * @param onProgress 进度回调
     * @param maxRetries 最大重试次数（默认5次）
     */
    async waitForImportTask(
        ticket: string, 
        onProgress?: (status: string) => void,
        maxRetries: number = 5
    ): Promise<{ token: string; url: string }> {
        let retryCount = 0;
        
        while (retryCount <= maxRetries) {
            try {
                const result = await this.queryImportTask(ticket);
                
                if (result.job_status === 0) {
                    // 成功完成
                    if (!result.token || !result.url) {
                        console.error('[飞书API] ❌ 导入任务完成但缺少必要信息');
                        this.debug('[飞书API] ❌ 导入任务完成但缺少必要信息:', result);
                        throw new Error('导入任务完成但未返回文档信息');
                    }
                    
                    // 验证和格式化URL
                    const formattedUrl = this.formatDocumentUrl(result.url, result.token);
                    
                    return {
                        token: result.token,
                        url: formattedUrl
                    };
                } else if (result.job_status === 1 || result.job_status === 2) {
                    // 任务进行中 (job_status === 1) 或处理中 (job_status === 2)
                    retryCount++;
                    onProgress?.('文档正在处理中，请稍候...');
                    
                    // 检查是否超过最大重试次数
                    if (retryCount > maxRetries) {
                        console.error(`[飞书API] 导入任务处理超时，已重试${maxRetries}次`);
                        throw new Error('导入任务处理超时，请稍后手动检查飞书云文档');
                    }
                    
                    // 计算递增等待时间：3秒 → 3秒 → 6秒 → 6秒 → 6秒
                    let waitTime = 3000; // 默认3秒
                    if (retryCount >= 3) {
                        waitTime = 6000; // 第3次及以后等待6秒
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    
                    // 继续循环重试
                    continue;
                } else {
                    // 未知状态或其他错误状态
                    console.error('[飞书API] 导入任务状态未知');
                    this.debug('[飞书API] 导入任务状态未知:', {
                        job_status: result.job_status,
                        job_error_msg: result.job_error_msg,
                        fullResult: result
                    });
                    
                    const errorMsg = result.job_error_msg || `未知的任务状态: ${result.job_status}`;
                    throw new Error(`导入任务失败: ${errorMsg}`);
                }
                
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                
                // 如果是任务失败或进行中的错误，直接抛出，不重试
                if (errorMessage.includes('导入任务失败') || errorMessage.includes('导入任务已提交')) {
                    throw error;
                }
                
                // 只有网络错误或其他异常才重试
                retryCount++;
                if (retryCount > maxRetries) {
                    console.error(`[飞书API] 已达到最大重试次数 (${maxRetries})，停止重试`);
                    throw error;
                }
                
                // 计算递增等待时间：3秒 → 3秒 → 6秒 → 6秒 → 6秒
                let waitTime = 3000; // 默认3秒
                if (retryCount >= 3) {
                    waitTime = 6000; // 第3次及以后等待6秒
                }
                
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
        
        throw new Error('导入任务失败：已达到最大重试次数');
    }
    
    /**
     * 获取文档所有块
     * @param documentId 文档ID
     */
    async getDocumentBlocks(documentId: string): Promise<DocumentBlock[]> {
        const token = await this.getAccessToken();
        const url = `${this.baseUrl}/docx/v1/documents/${documentId}/blocks`;
        
        const requestParam: RequestUrlParam = {
            url,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json; charset=utf-8'
            }
        };
        
        try {
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            this.apiCallCountCallback?.();
            
            const result: FeishuApiResponse<DocumentBlocksResponse> = response.json;
            
            if (result.code !== 0) {
                console.error('[飞书API] 获取文档块失败:', result.msg);
                this.debug('[飞书API] 获取文档块失败，错误详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`获取文档块失败: [${result.code}] ${result.msg}`);
            }
            
            if (!result.data || !result.data.items) {
                console.error('[飞书API] 响应中缺少items');
                this.debug('[飞书API] 响应中缺少items:', result);
                throw new Error('获取成功但未返回文档块数据');
            }
            
            return result.data.items;
        } catch (error) {
            this.logError('[飞书API] 获取文档块失败:', error, {
                requestUrl: url,
                hasToken: !!token
            });
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`获取文档块失败: ${errorMessage}`);
        }
    }
    
    /**
     * 更新文档块
     * @param documentId 文档ID
     * @param blockId 块ID
     * @param imageToken 图片token（file_token）
     */
    async updateDocumentBlock(documentId: string, blockId: string, imageToken: string, imageInfo?: ImageInfo): Promise<void> {
        const token = await this.getAccessToken();
        const url = `${this.baseUrl}/docx/v1/documents/${documentId}/blocks/${blockId}?document_revision_id=-1`;
        
        // 获取图片实际尺寸
        let width = 800;
        let height = 600;
        
        if (imageInfo) {
            try {
                if (typeof imageInfo.width === 'number' && imageInfo.width > 0 && typeof imageInfo.height === 'number' && imageInfo.height > 0) {
                    width = imageInfo.width;
                    height = imageInfo.height;
                } else if (imageInfo.svgConvertOptions) {
                    width = imageInfo.svgConvertOptions.originalWidth * imageInfo.svgConvertOptions.scale;
                    height = imageInfo.svgConvertOptions.originalHeight * imageInfo.svgConvertOptions.scale;
                    this.debug(`[DEBUG] SVG转换图片尺寸: originalWidth=${imageInfo.svgConvertOptions.originalWidth}, originalHeight=${imageInfo.svgConvertOptions.originalHeight}, scale=${imageInfo.svgConvertOptions.scale}, finalWidth=${width}, finalHeight=${height}`);
                } else {
                    // 对于普通图片，获取原始尺寸
                    const dimensions = await this.getImageDimensions(imageInfo.path);
                    if (dimensions) {
                        width = dimensions.width;
                        height = dimensions.height;
                    }
                }
                
                // 智能尺寸限制策略，针对不同宽高比使用不同的限制
                const aspectRatio = width / height;
                let maxWidth: number;
                let maxHeight: number;
                
                this.debug(`[DEBUG] 飞书上传前尺寸: width=${width}, height=${height}, aspectRatio=${aspectRatio}`);
                
                if (aspectRatio > 4) {
                    // 超宽图表：允许更大的宽度，限制高度
                    maxWidth = 2400;
                    maxHeight = 600;
                } else if (aspectRatio > 2.0) {
                    // 宽图表：中等宽度限制（调整判断条件从2.5到2.0）
                    maxWidth = 2000;
                    maxHeight = 800;
                } else if (aspectRatio < 0.8) {
                    // 高图表：限制宽度，允许更大高度（放宽判断条件从0.5到0.8）
                    maxWidth = 1000;
                    maxHeight = 2500; // 增加最大高度限制
                } else {
                    // 常规图表：使用原来的限制
                    maxWidth = 1200;
                    maxHeight = 800;
                }
                
                // 只有在图片确实过大时才进行缩放
                if (width > maxWidth || height > maxHeight) {
                    const ratio = Math.min(maxWidth / width, maxHeight / height);
                    this.debug(`[DEBUG] 需要缩放: maxWidth=${maxWidth}, maxHeight=${maxHeight}, ratio=${ratio}`);
                    width = Math.round(width * ratio);
                    height = Math.round(height * ratio);
                    this.debug(`[DEBUG] 缩放后尺寸: width=${width}, height=${height}`);
                } else {
                    this.debug(`[DEBUG] 无需缩放: maxWidth=${maxWidth}, maxHeight=${maxHeight}`);
                }
            } catch (error) {
                void error;
                // 获取图片尺寸失败，使用默认尺寸
            }
        }
        
        const requestBody = {
            replace_image: {
                token: imageToken,
                width: width,
                height: height,
                align: 2
            }
        };
        

        
        const requestBody_str = JSON.stringify(requestBody);
        
        const requestParam: RequestUrlParam = {
            url,
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: requestBody_str
        };
        
        try {
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            this.apiCallCountCallback?.();
            
            const result: FeishuApiResponse<unknown> = response.json;
            
            if (result.code !== 0) {
                console.error('[飞书API] 更新文档块失败:', result.msg);
                this.debug('[飞书API] 更新文档块失败，错误详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`更新文档块失败: [${result.code}] ${result.msg}`);
            }
            

        } catch (error) {
            this.logError('[飞书API] 更新文档块失败:', error, {
                requestUrl: url,
                hasToken: !!token
            });
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`更新文档块失败: ${errorMessage}`);
        }
    }
    
    /**
     * 处理文档中的图片（完整流程）
     * @param documentId 文档ID
     * @param imageInfos 图片信息数组
     * @param onProgress 进度回调
     */
    async processImagesInDocument(
        documentId: string, 
        imageInfos: ImageInfo[], 
        onProgress?: (status: string) => void
    ): Promise<void> {
        if (!imageInfos || imageInfos.length === 0) {
            return;
        }
        
        try {
            // 步骤一：获取文档所有块
            onProgress?.('正在获取文档结构...');
            const blocks = await this.getDocumentBlocks(documentId);
            
            // 找到图片块
            const imageBlocks = blocks.filter(block => block.block_type === 27); // 27表示图片块
            
            if (imageBlocks.length === 0) {
                return;
            }
            
            // 步骤二：按顺序上传图片并更新块
            for (let i = 0; i < imageInfos.length && i < imageBlocks.length; i++) {
                const imageInfo = imageInfos[i];
                const imageBlock = imageBlocks[i];
                
                if (!imageInfo || !imageBlock) {
                    continue;
                }
                
                onProgress?.(`正在处理图片 ${i + 1}/${imageInfos.length}: ${imageInfo.fileName}`);
                
                try {
                    // 读取本地图片文件并转换为base64
                    const fileResult = await this.readImageFileAsBase64(imageInfo.path);
                    if (!fileResult) {
                        throw new Error(`无法读取图片文件: ${imageInfo.path}`);
                    }
                    if (typeof fileResult.width === 'number' && fileResult.width > 0 && typeof fileResult.height === 'number' && fileResult.height > 0) {
                        imageInfo.width = fileResult.width;
                        imageInfo.height = fileResult.height;
                    }
                    
                    // 如果是SVG文件，保存转换选项到ImageInfo
                    if (fileResult.svgConvertOptions) {
                        imageInfo.svgConvertOptions = fileResult.svgConvertOptions;
                    }
                    
                    // 确定上传时使用的文件名（SVG文件需要转换为PNG文件名）
                    let uploadFileName = imageInfo.fileName;
                    if (SvgConverter.isSvgFile(imageInfo.fileName)) {
                        uploadFileName = SvgConverter.generatePngFileName(imageInfo.fileName);
                    }
                    
                    // 上传图片素材
                    const fileToken = await this.uploadImageMaterial(
                        uploadFileName, 
                        fileResult.base64, 
                        documentId,
                        imageBlock.block_id
                    );
                    
                    // 更新文档块
                    await this.updateDocumentBlock(
                        documentId, 
                        imageBlock.block_id, 
                        fileToken,
                        imageInfo
                    );
                    
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    console.error(`[飞书API] 处理图片 ${imageInfo.fileName} 失败:`, errorMessage);
                    this.debug(`[飞书API] 处理图片 ${imageInfo.fileName} 失败详情:`, {
                        error,
                        errorMessage,
                        errorStack: error instanceof Error ? error.stack : undefined
                    });
                    // 继续处理下一张图片，不中断整个流程
                    onProgress?.(`图片 ${imageInfo.fileName} 处理失败: ${errorMessage}`);
                }
            }
            
            onProgress?.('所有图片处理完成！');
            
        } catch (error) {
            this.logError('[飞书API] 图片处理流程失败:', error, {
                documentId,
                imageCount: imageInfos.length
            });
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`图片处理流程失败: ${errorMessage}`);
        }
    }
    
    /**
     * 获取图片尺寸
     * @param imagePath 图片文件路径
     * @returns 图片的宽度和高度
     */
    private async getImageDimensions(imagePath: string): Promise<{ width: number; height: number } | null> {
        try {
            // 处理相对路径，转换为绝对路径
            let fullPath = imagePath;
            
            // 如果是绝对路径，提取文件名进行搜索
            if (imagePath.match(/^[A-Za-z]:/) || imagePath.startsWith('/')) {
                const fileName = imagePath.split(/[/\\]/).pop();
                if (fileName) {
                    fullPath = fileName;
                }
            } else {
                // 移除开头的 ./ 如果存在
                fullPath = imagePath.replace(/^\.\//, '');
            }
            
            // 在Obsidian中查找图片文件
            const file = this.searchImageInVault(fullPath);
            if (!file) {
                console.warn('[飞书API] 无法找到图片文件:', fullPath);
                return null;
            }
            
            // 读取图片文件
            const arrayBuffer = await this.app?.vault.readBinary(file);
            if (!arrayBuffer) {
                console.warn('[飞书API] 无法读取图片文件内容:', fullPath);
                return null;
            }
            
            // 创建Image对象来获取尺寸
            return new Promise((resolve) => {
                const blob = new Blob([arrayBuffer]);
                const url = URL.createObjectURL(blob);
                const img = new Image();
                
                img.onload = () => {
                    URL.revokeObjectURL(url);
                    resolve({ width: img.width, height: img.height });
                };
                
                img.onerror = () => {
                    URL.revokeObjectURL(url);
                    console.warn('[飞书API] 无法解析图片尺寸:', fullPath);
                    resolve(null);
                };
                
                img.src = url;
            });
            
        } catch (error) {
            this.logError('[飞书API] 获取图片尺寸失败:', error, { imagePath });
            return null;
        }
    }

    private async getImageDimensionsFromArrayBuffer(arrayBuffer: ArrayBuffer): Promise<{ width: number; height: number } | null> {
        return new Promise((resolve) => {
            const blob = new Blob([arrayBuffer]);
            const url = URL.createObjectURL(blob);
            const img = new Image();

            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve({ width: img.width, height: img.height });
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(null);
            };

            img.src = url;
        });
    }

    private async getPngDimensionsFromBase64(base64: string): Promise<{ width: number; height: number } | null> {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                resolve({ width: img.width, height: img.height });
            };
            img.onerror = () => {
                resolve(null);
            };
            img.src = `data:image/png;base64,${base64}`;
        });
    }
    
    /**
     * 读取本地或远程图片文件并转换为base64
     * @param imagePath 图片文件路径或URL
     * @returns base64编码的图片内容和SVG转换选项（如果是SVG）
     */
    private async readImageFileAsBase64(imagePath: string): Promise<{ base64: string; width?: number; height?: number; svgConvertOptions?: { originalWidth: number; originalHeight: number; scale: number } } | null> {
        try {
            // 处理远程图片
            if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
                this.debug('[飞书API] 检测到远程图片，开始下载:', imagePath);
                try {
                    const response = await requestUrl({ url: imagePath });
                    const arrayBuffer = response.arrayBuffer;
                    const dimensions = await this.getImageDimensionsFromArrayBuffer(arrayBuffer);
                    const uint8Array = new Uint8Array(arrayBuffer);
                    const binaryString = Array.from(uint8Array, byte => String.fromCharCode(byte)).join('');
                    const base64Content = btoa(binaryString);
                    const result: { base64: string; width?: number; height?: number } = { base64: base64Content };
                    if (dimensions) {
                        result.width = dimensions.width;
                        result.height = dimensions.height;
                    }
                    return result;
                } catch (error) {
                    console.error('[飞书API] 下载远程图片失败:', imagePath, error);
                    return null;
                }
            }

            // 检查是否为Mermaid临时图片
            const fileName = imagePath.split(/[/\\]/).pop() || imagePath;
            if (FeishuApiClient.isMermaidTempImage(fileName)) {
                const cachedData = FeishuApiClient.getMermaidImageFromCache(fileName);
                if (cachedData) {
                    this.debug('[飞书API] 使用Mermaid缓存图片:', fileName);
                    const result: { base64: string; width?: number; height?: number; svgConvertOptions?: { originalWidth: number; originalHeight: number; scale: number } } = { 
                        base64: cachedData.base64Data
                    };
                    if (cachedData.svgConvertOptions) {
                        result.svgConvertOptions = cachedData.svgConvertOptions;
                    }
                    return result;
                } else {
                    console.error('[飞书API] Mermaid缓存图片未找到:', fileName);
                    return null;
                }
            }
            
            // 处理相对路径，转换为绝对路径
            let fullPath = imagePath;
            
            // 如果是绝对路径，提取文件名进行搜索
            if (imagePath.match(/^[A-Za-z]:/) || imagePath.startsWith('/')) {
                const fileName = imagePath.split(/[/\\]/).pop();
                if (fileName) {
                    fullPath = fileName;
                }
            } else {
                // 移除开头的 ./ 如果存在
                fullPath = imagePath.replace(/^\.\//,  '');
            }
            

            
            const app = this.app;
            if (!app) {
                throw new Error('App 未初始化');
            }
            
            let file: TFile | null = null;
            const abstractFile = app.vault.getAbstractFileByPath(fullPath);
            if (abstractFile instanceof TFile) {
                file = abstractFile;
            }
            
            // 如果直接路径找不到，在整个vault中搜索同名文件
            if (!file) {
                this.debug('[飞书API] 直接路径未找到，开始在vault中搜索文件:', fullPath);
                file = this.searchImageInVault(fullPath);
            }
            
            if (!file) {
                console.error('[飞书API] 找不到图片文件:', fullPath);
                return null;
            }
            
            // 检查是否为SVG文件
            const fileExtension = file.extension?.toLowerCase();
            if (fileExtension === 'svg') {
                // 处理SVG文件：读取为文本，转换为PNG
                const svgContent = await app.vault.read(file);
                
                // 检查SVG内容有效性
                if (!SvgConverter.isSvgFile(file.name, svgContent)) {
                    console.error('[飞书API] 无效的SVG文件:', file.path);
                    return null;
                }
                
                try {
                    // 获取推荐的转换选项
                    const options = SvgConverter.getRecommendedOptions(svgContent);
                    
                    // 转换SVG为PNG的base64
                    const pngBase64 = await SvgConverter.convertSvgToPng(svgContent, options);
                    const dimensions = await this.getPngDimensionsFromBase64(pngBase64);
                    const result: { base64: string; width?: number; height?: number; svgConvertOptions?: { originalWidth: number; originalHeight: number; scale: number } } = {
                        base64: pngBase64,
                        svgConvertOptions: {
                            originalWidth: options.width || 800,
                            originalHeight: options.height || 600,
                            scale: options.scale || 4
                        }
                    };
                    if (dimensions) {
                        result.width = dimensions.width;
                        result.height = dimensions.height;
                    }
                    return result;
                } catch (error) {
                    this.logError('[飞书API] SVG转PNG失败:', error, {
                        path: file.path
                    });
                    return null;
                }
            } else {
                // 处理其他格式的图片文件
                // 读取文件内容为ArrayBuffer
                const arrayBuffer = await app.vault.readBinary(file);
                const dimensions = await this.getImageDimensionsFromArrayBuffer(arrayBuffer);
                
                // 转换为base64
                const uint8Array = new Uint8Array(arrayBuffer);
                const binaryString = Array.from(uint8Array, byte => String.fromCharCode(byte)).join('');
                const base64Content = btoa(binaryString);
                const result: { base64: string; width?: number; height?: number } = { base64: base64Content };
                if (dimensions) {
                    result.width = dimensions.width;
                    result.height = dimensions.height;
                }
                return result;
            }
            
        } catch (error) {
            this.logError('[飞书API] 读取图片文件失败:', error, {
                path: imagePath
            });
            return null;
        }
    }
    
    /**
     * 在整个vault中搜索图片文件
     * @param fileName 文件名或路径
     * @returns 找到的文件对象
     */
    private searchImageInVault(fileName: string): TFile | null {
        if (!this.app?.vault) {
            return null;
        }
        
        // 提取纯文件名（去除路径）
        const targetFileName = fileName.split(/[/\\]/).pop();
        if (!targetFileName) {
            return null;
        }
        

        
        // 获取所有文件
        const allFiles = this.app.vault.getFiles();
        
        // 支持的图片扩展名
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
        
        // 搜索匹配的图片文件
        for (const file of allFiles) {
            // 检查是否为图片文件
            const hasImageExtension = imageExtensions.some(ext => 
                file.extension.toLowerCase() === ext.substring(1)
            );
            
            if (!hasImageExtension) {
                continue;
            }
            
            // 检查文件名是否匹配
            if (file.name === targetFileName || file.path === fileName) {
                return file;
            }
            
            // 如果目标文件名没有扩展名，尝试匹配基础名称
            if (!targetFileName.includes('.')) {
                const fileBaseName = file.name.substring(0, file.name.lastIndexOf('.'));
                if (fileBaseName === targetFileName) {
                    return file;
                }
            }
        }
        
        return null;
    }
    
    /**
     * 转换Obsidian图片语法为标准Markdown语法
     * @param markdownContent 包含Obsidian图片语法的Markdown内容
     * @returns 转换后的标准Markdown内容
     */
    static convertObsidianImageSyntax(markdownContent: string): string {
        // 匹配Obsidian格式的图片: ![[image.png]] 或 ![[image.png|alt text]]
        const obsidianImageRegex = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
        
        let convertedContent = markdownContent;
        let match;
        
        // 重置正则表达式的lastIndex
        obsidianImageRegex.lastIndex = 0;
        
        while ((match = obsidianImageRegex.exec(markdownContent)) !== null) {
            const fileName = match[1]; // 图片文件名
            if (!fileName) continue;
            
            const altText = match[2] || fileName; // alt文本，如果没有指定则使用文件名
            const obsidianSyntax = match[0]; // 完整的Obsidian语法
            
            // 转换为标准Markdown语法: ![alt](filename)，并对文件名进行URL编码以支持空格和特殊字符
            const encodedFileName = encodeURI(fileName);
            const standardSyntax = `![${altText}](${encodedFileName})`;
            
            // 替换内容
            convertedContent = convertedContent.replace(obsidianSyntax, standardSyntax);
            
        }
        
        return convertedContent;
    }
    
    /**
     * 提取Markdown中的图片信息
     * @param markdownContent Markdown内容
     * @param basePath 基础路径（用于解析相对路径）
     */
    static extractImageInfoFromMarkdown(markdownContent: string, basePath?: string): ImageInfo[] {
        const imageInfos: ImageInfo[] = [];
        
        // 先转换Obsidian图片语法为标准Markdown语法
        const convertedContent = FeishuApiClient.convertObsidianImageSyntax(markdownContent);
        
        // 匹配标准Markdown格式的图片: ![alt](path) 或 ![alt](path "title")
        const markdownImageRegex = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;
        
        let match;
        let position = 0;
        
        // 处理标准Markdown格式的图片（现在包括转换后的Obsidian图片）
        while ((match = markdownImageRegex.exec(convertedContent)) !== null) {
            const path = match[2];
            
            if (!path) continue;
            
            // 提取文件名
            // 对路径进行解码，处理URL编码的字符（如空格变为%20）
            const decodedPath = decodeURI(path);
            const fileName = decodedPath.split('/').pop() || decodedPath;
            const fullPath = basePath && !decodedPath.startsWith('http') ? `${basePath}/${decodedPath}` : decodedPath;
            
            imageInfos.push({
                path: fullPath,
                fileName: fileName,
                position: position++
            });
        }
        
        return imageInfos;
    }

    private static encodeBase64Utf8(content: string): string {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(content);
        let binary = '';
        for (const byte of bytes) {
            binary += String.fromCharCode(byte);
        }
        return btoa(binary);
    }
    
    /**
     * 直接上传文件到飞书云盘
     * @param fileName 文件名
     * @param markdownContent Markdown内容
     * @param documentId 目标文档ID（可选）
     * @param onProgress 进度回调
     */
    async uploadFileDirectly(
        fileName: string, 
        markdownContent: string, 
        documentId?: string,
        onProgress?: (status: string) => void
    ): Promise<{ token: string; url: string }> {
        try {
            onProgress?.('正在处理文档内容...');
            
            // 转换Obsidian图片语法为标准Markdown语法
            const convertedContent = FeishuApiClient.convertObsidianImageSyntax(markdownContent);
            
            onProgress?.('正在上传文件...');
            
            // 将Markdown内容转换为base64
            const fileContent = FeishuApiClient.encodeBase64Utf8(convertedContent);
            
            // 直接上传文件
            const fileToken = await this.uploadFile(fileName, fileContent, documentId || '');
            
            onProgress?.('上传完成！');
            
            // 构造文件URL（根据飞书API文档格式）
            const fileUrl = `https://open.feishu.cn/open-apis/drive/v1/files/${fileToken}`;
            
            return {
                token: fileToken,
                url: fileUrl
            };
        } catch (error) {
            this.logError('[飞书API] 直接上传文件失败:', error, { fileName, documentId });
            throw error;
        }
    }
    
    /**
     * 完整的文档上传流程（通过导入任务）- 带预处理图片信息
     * @param fileName 文件名
     * @param markdownContent Markdown内容
     * @param documentId 目标文档ID（可选）
     * @param onProgress 进度回调
     * @param preProcessedImageInfos 预处理的图片信息（按正确顺序）
     */
    async uploadDocumentWithImageInfos(
        fileName: string, 
        markdownContent: string, 
        documentId?: string,
        onProgress?: (status: string) => void,
        preProcessedImageInfos?: ImageInfo[]
    ): Promise<{ token: string; url: string }> {
        let mdFileToken: string | null = null;
        
        try {
            onProgress?.('正在处理文档内容...');
            
            // 转换Obsidian图片语法为标准Markdown语法
            const convertedContent = FeishuApiClient.convertObsidianImageSyntax(markdownContent);
            
            onProgress?.('正在上传文件到云空间...');
            
            // 将Markdown内容转换为base64
            const fileContent = FeishuApiClient.encodeBase64Utf8(convertedContent);
            
            // 先上传文件到云空间获取file_token（使用完整文件名包含扩展名）
            mdFileToken = await this.uploadFile(fileName, fileContent, documentId || '');
            
            onProgress?.('文件已上传，正在创建导入任务...');
            
            // 使用file_token创建导入任务（传递完整文件名，方法内部会处理扩展名分离）
            const ticket = await this.createImportTask(fileName, mdFileToken, documentId || '');
            
            onProgress?.('任务已创建，正在处理...');
            
            // 等待3秒让飞书开始处理任务，减少API调用次数
            await new Promise(resolve => setTimeout(resolve, 3000));
            onProgress?.('开始查询处理状态...');
            
            // 等待任务完成
            const result = await this.waitForImportTask(ticket, onProgress);
            
            // 使用预处理的图片信息或者提取图片信息
            let imageInfos: ImageInfo[];
            if (preProcessedImageInfos && preProcessedImageInfos.length > 0) {
                imageInfos = preProcessedImageInfos;
            } else {
                const adapter = this.app?.vault?.adapter;
                const basePath = getAdapterBasePath(adapter);
                imageInfos = FeishuApiClient.extractImageInfoFromMarkdown(markdownContent, basePath);
            }
            
            if (imageInfos.length > 0) {
                onProgress?.('正在处理文档中的图片...');
                await this.processImagesInDocument(result.token, imageInfos, onProgress);
            }
            
            // 转换完成后，静默删除MD文件（用户不会察觉）
            if (mdFileToken) {
                try {
                    this.debug('[飞书API] 开始清理临时MD文件，file_token:', mdFileToken);
                    await this.deleteFile(mdFileToken, 'file');
                    this.debug('[飞书API] 临时MD文件已清理');
                } catch (deleteError) {
                    // 删除失败不影响主流程，只记录日志
                    console.warn('[飞书API] 清理临时MD文件失败（不影响主功能）:', deleteError);
                }
            }
            
            onProgress?.('上传完成！');
            
            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[飞书API] 文档上传失败: ${errorMessage}`);
            this.debug('[飞书API] 文档上传失败详情:', {
                error,
                errorMessage,
                fileName,
                documentId
            });
            
            // 如果上传失败，尝试清理临时文件
            if (mdFileToken) {
                try {
                    this.debug('[飞书API] 上传失败，开始清理临时MD文件，file_token:', mdFileToken);
                    await this.deleteFile(mdFileToken, 'file');
                    this.debug('[飞书API] 临时MD文件已清理');
                } catch (deleteError) {
                    console.warn('[飞书API] 清理临时MD文件失败:', deleteError);
                }
            }
            
            throw new Error(`文档上传失败: ${errorMessage}`);
        }
    }

    /**
     * 完整的文档上传流程（通过导入任务）
     * @param fileName 文件名
     * @param markdownContent Markdown内容
     * @param documentId 目标文档ID（可选）
     * @param onProgress 进度回调
     */
    async uploadDocument(
        fileName: string, 
        markdownContent: string, 
        documentId?: string,
        onProgress?: (status: string) => void
    ): Promise<{ token: string; url: string }> {
        let mdFileToken: string | null = null;
        
        try {
            onProgress?.('正在处理文档内容...');
            
            // 转换Obsidian图片语法为标准Markdown语法
            const convertedContent = FeishuApiClient.convertObsidianImageSyntax(markdownContent);
            
            onProgress?.('正在上传文件到云空间...');
            
            // 将Markdown内容转换为base64
            const fileContent = FeishuApiClient.encodeBase64Utf8(convertedContent);
            
            // 先上传文件到云空间获取file_token（使用完整文件名包含扩展名）
            mdFileToken = await this.uploadFile(fileName, fileContent, documentId || '');
            
            onProgress?.('文件已上传，正在创建导入任务...');
            
            // 使用file_token创建导入任务（传递完整文件名，方法内部会处理扩展名分离）
            const ticket = await this.createImportTask(fileName, mdFileToken, documentId || '');
            
            onProgress?.('任务已创建，正在处理...');
            
            // 等待3秒让飞书开始处理任务，减少API调用次数
            await new Promise(resolve => setTimeout(resolve, 3000));
            onProgress?.('开始查询处理状态...');
            
            // 等待任务完成
            const result = await this.waitForImportTask(ticket, onProgress);
            
            // 检查是否有图片需要处理
            const adapter = this.app?.vault?.adapter;
            const basePath = getAdapterBasePath(adapter);
            const imageInfos = FeishuApiClient.extractImageInfoFromMarkdown(markdownContent, basePath);
            if (imageInfos.length > 0) {
                onProgress?.('正在处理文档中的图片...');
                await this.processImagesInDocument(result.token, imageInfos, onProgress);
            }
            
            // 转换完成后，静默删除MD文件（用户不会察觉）
            if (mdFileToken) {
                try {
                    this.debug('[飞书API] 开始清理临时MD文件，file_token:', mdFileToken);
                    await this.deleteFile(mdFileToken, 'file');
                    this.debug('[飞书API] 临时MD文件已清理');
                } catch (deleteError) {
                    // 删除失败不影响主流程，只记录日志
                    console.warn('[飞书API] 清理临时MD文件失败（不影响主功能）:', deleteError);
                }
            }
            
            onProgress?.('上传完成！');
            
            return result;
        } catch (error) {
            // 如果主流程失败，也尝试清理MD文件
            if (mdFileToken) {
                try {
                    this.debug('[飞书API] 主流程失败，尝试清理临时MD文件');
                    await this.deleteFile(mdFileToken, 'file');
                } catch (deleteError) {
                    console.warn('[飞书API] 清理临时MD文件失败:', deleteError);
                }
            }
            
            this.logError('[飞书API] 上传文档失败:', error, { fileName, documentId });
            throw error;
        }
    }
    
    /**
     * 测试API连接
     */
    async testConnection(): Promise<boolean> {
        try {
            await this.getAccessToken();
            return true;
        } catch (error) {
            this.logError('[飞书API] 测试飞书API连接失败:', error);
            return false;
        }
    }
    
    /**
     * 格式化飞书文档URL
     * @param url 原始URL
     * @param token 文档token
     */
    private formatDocumentUrl(url: string, token: string): string {
        try {
            // 如果URL已经是完整的飞书文档链接，直接返回
            if (url.startsWith('https://') && (url.includes('feishu.cn') || url.includes('larkoffice.com'))) {
                return url;
            }
            
            // 如果URL是相对路径或只有token，构造完整的飞书文档URL
            if (!url.startsWith('http')) {
                // 根据飞书API文档，文档URL格式为：https://[domain]/docs/[doc_token]
                // 这里使用飞书的标准文档访问格式
                const formattedUrl = `https://open.feishu.cn/document/${token}`;
                return formattedUrl;
            }
            
            // 如果URL格式不正确，尝试修复
            return url;
            
        } catch (error) {
            this.logError('[飞书API] URL格式化失败:', error, { url, token });
            // 如果格式化失败，返回原始URL
            return url;
        }
    }
    

    /**
     * 转移文档所有权给用户
     * @param docToken 文档token
     * @param userId 用户ID
     */
    async transferDocumentOwnership(docToken: string, userId: string): Promise<boolean> {
        const token = await this.getAccessToken();
        
        this.debug('[飞书API] 转移文档所有权:', {
            docToken,
            userId
        });
        
        try {
            const transferUrl = `${this.baseUrl}/drive/v1/permissions/${docToken}/members/transfer_owner?need_notification=false&old_owner_perm=full_access&remove_old_owner=false&stay_put=true&type=docx`;
            
            const requestBody = {
                member_id: userId,
                member_type: "userid"
            };
            
            const requestParam: RequestUrlParam = {
                url: transferUrl,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            };
            
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            this.apiCallCountCallback?.();
            const result: FeishuApiResponse<unknown> = response.json;
            
            if (result.code === 0) {
                return true;
            } else {
                console.error(`[飞书API] ❌ 文档所有权转移失败: [${result.code}] ${result.msg}`);
                this.debug('[飞书API] ❌ 文档所有权转移失败详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`转移文档所有权失败: [${result.code}] ${result.msg}`);
            }
            
        } catch (error: unknown) {
            const errorMeta = getErrorMeta(error);
            this.logError('[飞书API] ❌ 所有权转移异常:', error, {
                status: errorMeta.status,
                statusText: errorMeta.statusText,
                response: errorMeta.response,
                json: errorMeta.json
            });
            throw error;
        }
    }

    /**
     * 设置文档权限
     * @param docToken 文档token
     * @param permissions 权限设置
     * @param userId 用户ID（用于所有权转移）
     */
    async setDocumentPermissions(
        docToken: string, 
        permissions: {
            isPublic: boolean;
            allowCopy: boolean;
            allowCreateCopy: boolean;
            allowPrintDownload: boolean;
            copyEntity?: string;
            securityEntity?: string;
        },
        userId?: string
    ): Promise<boolean> {
        const token = await this.getAccessToken();
        

        
        try {
            // 第零步：如果提供了用户ID，先转移文档所有权
            if (userId) {
                await this.transferDocumentOwnership(docToken, userId);
                
                // 等待1秒让所有权转移生效
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // 一次性设置所有权限
            const requestBody: PermissionRequestBody = {
                external_access_entity: 'open'
            };
            
            // 根据用户选择添加相应的权限参数
            if (permissions.isPublic) {
                requestBody.link_share_entity = 'anyone_readable';
            }
            
            // 使用传入的copyEntity参数，如果没有则根据allowCopy设置
            if (permissions.copyEntity) {
                requestBody.copy_entity = permissions.copyEntity;
            } else if (permissions.allowCopy) {
                requestBody.copy_entity = 'anyone_can_view';
            }
            
            // 使用传入的securityEntity参数，如果没有则根据allowCreateCopy设置
            if (permissions.securityEntity) {
                requestBody.security_entity = permissions.securityEntity;
            } else if (permissions.allowCreateCopy || permissions.allowPrintDownload) {
                requestBody.security_entity = 'anyone_can_view';
            }
            
            const publicUrl = `${this.baseUrl}/drive/v2/permissions/${docToken}/public?type=docx`;
            
            // 一次性设置所有权限
            await this.executePermissionRequest(publicUrl, token, requestBody, '权限设置');
            
            return true;
            
        } catch (error: unknown) {
            const errorMeta = getErrorMeta(error);
            this.logError('[飞书API] ❌ 权限设置失败:', error, {
                status: errorMeta.status,
                statusText: errorMeta.statusText,
                response: errorMeta.response,
                json: errorMeta.json
            });
            throw error;
        }
    }

    /**
     * 仅更新文档权限（不包含所有权转移）
     * @param docToken 文档token
     * @param permissions 权限设置
     */
    async updateDocumentPermissionsOnly(
        docToken: string, 
        permissions: {
            isPublic: boolean;
            allowCopy: boolean;
            allowCreateCopy: boolean;
            allowPrintDownload: boolean;
            copyEntity?: string;
            securityEntity?: string;
        }
    ): Promise<boolean> {
        const token = await this.getAccessToken();
        
        try {
            // 一次性设置所有权限
            const requestBody: PermissionRequestBody = {
                external_access_entity: 'open'
            };
            
            // 根据用户选择添加相应的权限参数
            if (permissions.isPublic) {
                requestBody.link_share_entity = 'anyone_readable';
            }
            
            // 使用传入的copyEntity参数，如果没有则根据allowCopy设置
            if (permissions.copyEntity) {
                requestBody.copy_entity = permissions.copyEntity;
            } else if (permissions.allowCopy) {
                requestBody.copy_entity = 'anyone_can_view';
            }
            
            // 使用传入的securityEntity参数，如果没有则根据allowCreateCopy设置
            if (permissions.securityEntity) {
                requestBody.security_entity = permissions.securityEntity;
            } else if (permissions.allowCreateCopy || permissions.allowPrintDownload) {
                requestBody.security_entity = 'anyone_can_view';
            }
            
            const publicUrl = `${this.baseUrl}/drive/v2/permissions/${docToken}/public?type=docx`;
            
            // 一次性设置所有权限
            await this.executePermissionRequest(publicUrl, token, requestBody, '权限设置（无所有权转移）');
            
            return true;
            
        } catch (error: unknown) {
            const errorMeta = getErrorMeta(error);
            this.logError('[飞书API] ❌ 权限设置失败（无所有权转移）:', error, {
                status: errorMeta.status,
                statusText: errorMeta.statusText,
                response: errorMeta.response,
                json: errorMeta.json
            });
            throw error;
        }
    }
    
    /**
     * 执行权限设置请求（带重试机制）
     */
    private async executePermissionRequest(
        url: string, 
        token: string, 
        requestBody: PermissionRequestBody, 
        stepName: string
    ): Promise<void> {
        let retryCount = 0;
        const maxRetries = 3;
        const retryDelay = 10000; // 10秒
        
        while (retryCount <= maxRetries) {
            try {
                const requestParam: RequestUrlParam = {
                    url,
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    body: JSON.stringify(requestBody)
                };
                
                const response = await requestUrl(requestParam);
                // 增加API调用计数
                this.apiCallCountCallback?.();
                const result: FeishuApiResponse<unknown> = response.json;
                
                if (result.code === 0) {
                    return;
                } else {
                    // 业务错误，不重试
                    console.error(`[飞书API] ❌ ${stepName}失败: [${result.code}] ${result.msg}`);
                    this.debug(`[飞书API] ❌ ${stepName}失败详情:`, {
                        code: result.code,
                        msg: result.msg,
                        fullResult: result
                    });
                    throw new Error(`${stepName}失败: [${result.code}] ${result.msg}`);
                }
                
            } catch (error: unknown) {
                const errorMeta = getErrorMeta(error);
                this.logError(`[飞书API] ❌ ${stepName}第${retryCount + 1}次请求异常:`, error, {
                    status: errorMeta.status,
                    statusText: errorMeta.statusText,
                    response: errorMeta.response,
                    json: errorMeta.json,
                    retryCount,
                    maxRetries
                });

                // 检查是否是500错误
                if (errorMeta.status === 500 && retryCount < maxRetries) {
                    retryCount++;
                    console.warn(`[飞书API] ⚠️ ${stepName}遇到500错误，${retryDelay/1000}秒后进行第${retryCount + 1}次重试...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                } else {
                    // 非500错误或已达到最大重试次数
                    this.logError(`[飞书API] ❌ ${stepName}最终失败:`, error, {
                        status: errorMeta.status,
                        statusText: errorMeta.statusText,
                        response: errorMeta.response,
                        json: errorMeta.json,
                        retryCount,
                        maxRetries
                    });
                    throw error;
                }
            }
        }
        
        if (retryCount > maxRetries) {
            throw new Error(`${stepName}失败：服务器错误，已重试3次仍无法完成`);
        }
    }
    
    /**
     * 更新应用凭证
     */
    /**
     * 删除文件
     * @param docToken 文档token
     * @param fileType 文件类型
     */
    async deleteFile(docToken: string, fileType: string = 'docx'): Promise<boolean> {
        const token = await this.getAccessToken();
        
        try {
            const deleteUrl = `${this.baseUrl}/drive/v1/files/${docToken}?type=${fileType}`;
            
            const requestParam: RequestUrlParam = {
                url: deleteUrl,
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json; charset=utf-8'
                }
            };
            
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            this.apiCallCountCallback?.();
            const result: FeishuApiResponse<unknown> = response.json;
            
            if (result.code === 0) {
                return true;
            } else {
                console.error(`[飞书API] ❌ 文件删除失败: [${result.code}] ${result.msg}`);
                this.debug('[飞书API] ❌ 文件删除失败详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`删除文件失败: [${result.code}] ${result.msg}`);
            }
            
        } catch (error: unknown) {
            const errorMeta = getErrorMeta(error);
            this.logError('[飞书API] ❌ 删除文件异常:', error, {
                status: errorMeta.status,
                statusText: errorMeta.statusText,
                response: errorMeta.response,
                json: errorMeta.json
            });
            throw error;
        }
    }

    updateCredentials(appId: string, appSecret: string): void {
        this.appId = appId;
        this.appSecret = appSecret;
        this.accessToken = null;
        this.tokenExpireTime = 0;
    }
    
    /**
     * 添加Mermaid图片到缓存
     * @param fileName 文件名
     * @param base64Data base64图片数据
     * @param svgConvertOptions SVG转换选项（包含原始尺寸信息）
     */
    static addMermaidImageToCache(fileName: string, base64Data: string, svgConvertOptions?: { originalWidth: number; originalHeight: number; scale: number }): void {
        const cacheData: { base64Data: string; svgConvertOptions?: { originalWidth: number; originalHeight: number; scale: number } } = { base64Data };
        if (svgConvertOptions) {
            cacheData.svgConvertOptions = svgConvertOptions;
        }
        this.mermaidImageCache.set(fileName, cacheData);
    }
    
    /**
     * 从缓存获取Mermaid图片
     * @param fileName 文件名
     * @returns 缓存的图片信息（包含base64数据和转换选项）
     */
    static getMermaidImageFromCache(fileName: string): { base64Data: string; svgConvertOptions?: { originalWidth: number; originalHeight: number; scale: number } } | undefined {
        return this.mermaidImageCache.get(fileName);
    }
    
    /**
     * 清除Mermaid图片缓存
     */
    static clearMermaidImageCache(): void {
        this.mermaidImageCache.clear();
    }
    
    /**
     * 检查是否为Mermaid临时图片
     * @param fileName 文件名
     * @returns 是否为Mermaid临时图片
     */
    static isMermaidTempImage(fileName: string): boolean {
        return fileName.startsWith('temp_mermaid-') || this.mermaidImageCache.has(fileName);
    }

    /**
     * 获取文档所有块的详细信息（支持 Callout 转换）
     * @param documentId 文档ID
     * @returns 文档块数组（包含完整的块信息）
     */
    async getDocumentBlocksDetailed(documentId: string): Promise<DocumentBlock[]> {
        try {
            const token = await this.getAccessToken();
            const allBlocks: DocumentBlock[] = [];
            let pageToken: string | undefined;
            let hasMore = true;

            while (hasMore) {
                const url = `${this.baseUrl}/docx/v1/documents/${documentId}/blocks`;
                const params: Record<string, string> = {
                    page_size: '500',
                    user_id_type: 'user_id'
                };
                
                if (pageToken) {
                    params['page_token'] = pageToken;
                }

                const requestParam: RequestUrlParam = {
                    url: url + '?' + new URLSearchParams(params).toString(),
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                };

                if (this.apiCallCountCallback) {
                    this.apiCallCountCallback();
                }

                const response = await requestUrl(requestParam);
                const result: FeishuApiResponse<DocumentBlocksResponse> = response.json;

                if (result.code !== 0) {
                    throw new Error(`获取文档块失败: ${result.msg}`);
                }

                allBlocks.push(...result.data.items);
                hasMore = result.data.has_more;
                pageToken = result.data.page_token;
            }

            return allBlocks;
        } catch (error) {
            this.logError('[飞书API] 获取文档块详细信息失败:', error, { documentId });
            throw error;
        }
    }

    /**
     * 批量更新文档块（支持 Callout 转换）
     * @param documentId 文档ID
     * @param requests 批量更新请求数组
     * @returns 更新结果
     */
    async batchUpdateDocumentBlocks(
        documentId: string, 
        requests: BlockUpdateRequest[]
    ): Promise<unknown> {
        try {
            const token = await this.getAccessToken();
            const url = `${this.baseUrl}/docx/v1/documents/${documentId}/blocks/batch_update?document_revision_id=-1`;

            const requestBody = {
                requests: requests
            };

            const requestParam: RequestUrlParam = {
                url,
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            };

            this.debug('[飞书API] 批量更新文档块:', {
                documentId,
                requestCount: requests.length,
                requests: requests.map(req => ({
                    hasInsertBlock: !!req.insert_block,
                    hasUpdateTextElements: !!req.update_text_elements,
                    hasMergeTableCells: !!req.merge_table_cells,
                    hasReplaceImage: !!req.replace_image,
                    blockId: req.block_id,
                    parentId: req.parent_id,
                    index: req.index
                }))
            });

            if (this.apiCallCountCallback) {
                this.apiCallCountCallback();
            }

            const response = await requestUrl(requestParam);
            const result: FeishuApiResponse<unknown> = response.json;

            if (result.code !== 0) {
                throw new Error(`批量更新文档块失败: ${result.msg}`);
            }

            this.debug('[飞书API] 批量更新文档块成功:', {
                documentId,
                updatedCount: requests.length,
                result: result.data
            });

            return result.data;
        } catch (error) {
            this.logError('[飞书API] 批量更新文档块失败:', error, {
                documentId,
                requestCount: requests.length
            });
            throw error;
        }
    }

    /**
     * 创建文档块
     * @param documentId 文档ID
     * @param parentId 父块ID
     * @param index 插入位置索引
     * @param children 要创建的子块数组
     * @returns 创建结果
     */
    async createDocumentBlocks(
        documentId: string, 
        parentId: string, 
        index: number, 
        children: DocumentBlockPayload[]
    ): Promise<unknown> {
        try {
            const token = await this.getAccessToken();
            const url = `${this.baseUrl}/docx/v1/documents/${documentId}/blocks/${parentId}/children?document_revision_id=-1`;

            const requestBody = {
                index,
                children
            };

            const requestParam: RequestUrlParam = {
                url,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            };

            this.debug('[飞书API] 创建文档块:', {
                documentId,
                parentId,
                index,
                childrenCount: children.length,
                requestBody
            });

            if (this.apiCallCountCallback) {
                this.apiCallCountCallback();
            }

            const response = await requestUrl(requestParam);
            const result: FeishuApiResponse<unknown> = response.json;

            this.debug('[飞书API] 创建文档块原始响应:', {
                status: response.status,
                headers: response.headers,
                body: result
            });

            if (result.code !== 0) {
                const errorDetails = {
                    code: result.code,
                    msg: result.msg,
                    data: result.data,
                    httpStatus: response.status,
                    requestUrl: url,
                    requestBody
                };
                console.error(`[飞书API] 创建文档块失败: [${result.code}] ${result.msg}`);
                this.debug('[飞书API] 创建文档块详细错误信息:', errorDetails);
                throw new Error(`创建文档块失败: ${result.msg} (code: ${result.code})`);
            }

            this.debug('[飞书API] 创建文档块成功:', {
                documentId,
                parentId,
                index,
                result: result.data
            });

            return result.data;
        } catch (error) {
            this.logError('[飞书API] 创建文档块失败:', error, {
                documentId,
                parentId,
                index,
                childrenCount: children.length,
                requestUrl: `${this.baseUrl}/docx/v1/documents/${documentId}/blocks/${parentId}/children?document_revision_id=-1`,
                requestBody: {
                    index,
                    children
                }
            });
            throw error;
        }
    }

    /**
     * 创建嵌套文档块（使用descendant API）
     * @param documentId 文档ID
     * @param parentId 父块ID
     * @param index 插入位置索引
     * @param childrenIds 子块ID数组
     * @param descendants 嵌套块定义数组
     * @returns 创建结果
     */
    async createDocumentDescendants(
        documentId: string,
        parentId: string,
        index: number,
        childrenIds: string[],
        descendants: DocumentBlockPayload[]
    ): Promise<unknown> {
        try {
            const token = await this.getAccessToken();
            const url = `${this.baseUrl}/docx/v1/documents/${documentId}/blocks/${parentId}/descendant?document_revision_id=-1`;

            const requestBody = {
                children_id: childrenIds,
                descendants: descendants,
                index
            };

            const requestParam: RequestUrlParam = {
                url,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            };

            this.debug('[飞书API] 创建嵌套文档块:', {
                documentId,
                parentId,
                index,
                childrenIds,
                descendantsCount: descendants.length,
                requestBody
            });

            if (this.apiCallCountCallback) {
                this.apiCallCountCallback();
            }

            const response = await requestUrl(requestParam);
            const result: FeishuApiResponse<unknown> = response.json;

            this.debug('[飞书API] 创建嵌套文档块原始响应:', {
                status: response.status,
                headers: response.headers,
                body: result
            });

            if (result.code !== 0) {
                const errorDetails = {
                    code: result.code,
                    msg: result.msg,
                    data: result.data,
                    httpStatus: response.status,
                    requestUrl: url,
                    requestBody
                };
                console.error(`[飞书API] 创建嵌套文档块失败: [${result.code}] ${result.msg}`);
                this.debug('[飞书API] 创建嵌套文档块详细错误信息:', errorDetails);
                throw new Error(`创建嵌套文档块失败: ${result.msg} (code: ${result.code})`);
            }

            this.debug('[飞书API] 创建嵌套文档块成功:', {
                documentId,
                parentId,
                index,
                result: result.data
            });

            return result.data;
        } catch (error) {
            this.logError('[飞书API] 创建嵌套文档块失败:', error, {
                documentId,
                parentId,
                index,
                childrenIds,
                descendantsCount: descendants.length,
                requestUrl: `${this.baseUrl}/docx/v1/documents/${documentId}/blocks/${parentId}/descendant?document_revision_id=-1`,
                requestBody: {
                    children_id: childrenIds,
                    descendants: descendants,
                    index
                }
            });
            throw error;
        }
    }

    /**
     * 批量删除多个文档块
     * @param documentId 文档ID
     * @param parentId 父块ID
     * @param blockIds 要删除的块ID数组
     * @returns 删除结果
     */
    async batchDeleteDocumentBlocks(documentId: string, parentId: string, startIndex: number, endIndex: number): Promise<unknown> {
        return this.queueDeleteRequest(async () => {
            try {
                const token = await this.getAccessToken();
                const url = `${this.baseUrl}/docx/v1/documents/${documentId}/blocks/${parentId}/children/batch_delete?document_revision_id=-1`;

                const deleteBody = {
                    start_index: startIndex,
                    end_index: endIndex
                };

                const requestParam: RequestUrlParam = {
                    url,
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(deleteBody)
                };

                this.debug('[飞书API] 批量删除文档块:', {
                    documentId,
                    parentId,
                    startIndex,
                    endIndex,
                    deleteCount: endIndex - startIndex,  // 左闭右开区间: [start, end)
                    deleteBody
                });

                if (this.apiCallCountCallback) {
                    this.apiCallCountCallback();
                }

                const response = await requestUrl(requestParam);
                const result: FeishuApiResponse<unknown> = response.json;

                if (result.code !== 0) {
                    throw new Error(`批量删除文档块失败: ${result.msg}`);
                }

                this.debug('[飞书API] 批量删除文档块成功:', {
                    documentId,
                    parentId,
                    startIndex,
                    endIndex,
                    deletedCount: endIndex - startIndex,  // 左闭右开区间: [start, end)
                    result: result.data
                });

                return result.data;
            } catch (error) {
                this.logError('[飞书API] 批量删除文档块失败:', error, {
                    documentId,
                    parentId,
                    startIndex,
                    endIndex
                });
                throw error;
            }
        });
    }

    /**
     * 删除文档块
     * @param documentId 文档ID
     * @param blockId 块ID
     * @returns 删除结果
     */
    async deleteDocumentBlock(documentId: string, blockId: string, parentId?: string, index?: number): Promise<unknown> {
        return this.queueDeleteRequest(async () => {
            try {
                const token = await this.getAccessToken();
                const url = `${this.baseUrl}/docx/v1/documents/${documentId}/blocks/${parentId || blockId}/children/batch_delete?document_revision_id=-1`;

                // 如果提供了索引，使用索引范围删除；否则使用block_ids删除
                const deleteBody = index !== undefined ? {
                    start_index: index,
                    end_index: index + 1
                } : {
                    block_ids: [blockId]
                };

                const requestParam: RequestUrlParam = {
                    url,
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(deleteBody)
                };

                this.debug('[飞书API] 删除文档块:', {
                    documentId,
                    blockId,
                    parentId,
                    index,
                    deleteMethod: index !== undefined ? 'by_index' : 'by_block_id',
                    deleteBody
                });

                if (this.apiCallCountCallback) {
                    this.apiCallCountCallback();
                }

                const response = await requestUrl(requestParam);
                const result: FeishuApiResponse<unknown> = response.json;

                if (result.code !== 0) {
                    throw new Error(`删除文档块失败: ${result.msg}`);
                }

                this.debug('[飞书API] 删除文档块成功:', {
                    documentId,
                    blockId,
                    result: result.data
                });

                return result.data;
            } catch (error) {
                this.logError('[飞书API] 删除文档块失败:', error, { documentId, blockId, parentId, index });
                throw error;
            }
        });
    }

    /**
     * 转换 Markdown 为文档块（支持 Callout 检测）
     * @param content Markdown 内容
     * @returns 转换结果
     */
    async convertMarkdownToBlocks(content: string): Promise<MarkdownConvertResponse> {
        try {
            const token = await this.getAccessToken();
            const url = `${this.baseUrl}/docx/v1/documents/blocks/convert`;

            const requestBody = {
                content_type: 'markdown',
                content: content
            };

            const requestParam: RequestUrlParam = {
                url,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            };

            this.debug('[飞书API] 转换 Markdown 为文档块:', {
                contentLength: content.length,
                contentPreview: content.substring(0, 100) + (content.length > 100 ? '...' : '')
            });

            if (this.apiCallCountCallback) {
                this.apiCallCountCallback();
            }

            const response = await requestUrl(requestParam);
            const result: FeishuApiResponse<MarkdownConvertResponse> = response.json;

            if (result.code !== 0) {
                throw new Error(`转换 Markdown 失败: ${result.msg}`);
            }

            this.debug('[飞书API] 转换 Markdown 成功:', {
                blocksCount: result.data?.blocks?.length || 0
            });

            return result.data;
        } catch (error) {
            this.logError('[飞书API] 转换 Markdown 失败:', error, { contentLength: content.length });
            throw error;
        }
    }
}

/**
 * 创建飞书API客户端实例
 */
export function createFeishuClient(appId: string, appSecret: string, app?: App, apiCallCountCallback?: () => void): FeishuApiClient {
    return new FeishuApiClient(appId, appSecret, app, apiCallCountCallback);
}
