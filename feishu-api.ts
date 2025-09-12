import { requestUrl, RequestUrlParam } from 'obsidian';

// 飞书API响应接口
export interface FeishuApiResponse<T = any> {
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
        style: any;
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
        text_element_style?: any;
    };
}

// 图片信息结构
export interface ImageInfo {
    path: string;
    fileName: string;
    position: number;
    blockId?: string;
}

// 飞书API客户端类
export class FeishuApiClient {
    private appId: string;
    private appSecret: string;
    private accessToken: string | null = null;
    private tokenExpireTime: number = 0;
    private app?: any;
    private apiCallCountCallback: (() => void) | undefined;
    private tokenRefreshPromise: Promise<string> | null = null; // 防止并发token获取
    
    // 飞书API基础URL
    private readonly baseUrl = 'https://open.feishu.cn/open-apis';
    
    // 限速相关属性
    private deleteRequestQueue: Array<() => Promise<any>> = [];
    private isProcessingDeleteQueue = false;
    private lastDeleteRequestTime = 0;
    private readonly DELETE_REQUEST_INTERVAL = 350; // 每次删除请求间隔350ms，确保不超过每秒3次
    
    constructor(appId: string, appSecret: string, app?: any, apiCallCountCallback?: () => void) {
        this.appId = appId;
        this.appSecret = appSecret;
        this.app = app;
        this.apiCallCountCallback = apiCallCountCallback;
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
                    console.error('[飞书API] 删除请求执行失败:', error);
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
                    reject(error);
                }
            };
            
            this.deleteRequestQueue.push(wrappedRequest);
            this.processDeleteQueue().catch(reject);
        });
    }
    
    /**
     * 获取访问令牌
     */
    async getAccessToken(): Promise<string> {
        // 检查token是否还有效（提前30分钟刷新，符合飞书API最佳实践）
        const now = Date.now();
        if (this.accessToken && now < this.tokenExpireTime - 30 * 60 * 1000) {
            console.log('[飞书API] 使用缓存的访问令牌，剩余有效时间:', Math.round((this.tokenExpireTime - now) / 60000), '分钟');
            return this.accessToken;
        }
        
        // 如果已经有正在进行的token刷新请求，等待它完成
        if (this.tokenRefreshPromise) {
            console.log('[飞书API] 等待正在进行的token刷新请求...');
            return await this.tokenRefreshPromise;
        }
        
        console.log('[飞书API] 开始获取新的访问令牌');
        
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
        
        console.log('[飞书API] 请求参数:', {
            url: requestParam.url,
            method: requestParam.method,
            headers: requestParam.headers,
            appId: this.appId ? '已配置' : '未配置',
            appSecret: this.appSecret ? '已配置' : '未配置'
        });
        
        try {
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            console.log('[飞书API] 🚀 调用getAccessToken API');
            this.apiCallCountCallback?.();
            console.log('[飞书API] 收到响应:', {
                status: response.status,
                headers: response.headers
            });
            
            const result: any = response.json;
            console.log('[飞书API] 响应内容:', {
                code: result.code,
                msg: result.msg,
                hasTenantAccessToken: !!result.tenant_access_token,
                fullResponse: result
            });
            
            // 详细检查响应结构 - 飞书API直接返回tenant_access_token字段
            if (!result.tenant_access_token) {
                console.error('[飞书API] 响应中缺少tenant_access_token字段，完整响应:', JSON.stringify(result, null, 2));
                throw new Error(`API响应格式错误: 缺少tenant_access_token字段`);
            }
            
            if (result.code !== 0) {
                throw new Error(`获取访问令牌失败: ${result.msg}`);
            }
            
            this.accessToken = result.tenant_access_token;
            // 设置过期时间（使用完整的有效期，通过30分钟提前刷新策略管理）
            this.tokenExpireTime = now + result.expire * 1000;
            
            console.log('[飞书API] 访问令牌获取成功:', {
                tokenLength: this.accessToken?.length || 0,
                tokenPrefix: this.accessToken?.substring(0, 20) + '...',
                expireSeconds: result.expire,
                expireTime: new Date(this.tokenExpireTime).toISOString(),
                currentTime: new Date(now).toISOString(),
                timeUntilExpire: this.tokenExpireTime - now
            });
            return this.accessToken!; // 使用非空断言，因为我们已经验证了token存在
        } catch (error) {
            console.error('[飞书API] 获取访问令牌失败:', error);
            
            // 详细的错误分析
            if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
                console.error('[飞书API] 网络连接错误，可能原因:');
                console.error('1. 网络连接不稳定或断开');
                console.error('2. 防火墙或代理阻止了请求');
                console.error('3. 飞书API服务暂时不可用');
                console.error('4. DNS解析问题');
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
        
        console.log('[飞书API] 开始上传文件:', {
            fileName,
            folderToken,
            url,
            hasToken: !!token,
            tokenPrefix: token ? token.substring(0, 10) + '...' : 'none',
            bodySize: body.length,
            boundary
        });
        
        try {
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            console.log('[飞书API] 🚀 调用uploadFile API');
            this.apiCallCountCallback?.();
            const result: FeishuApiResponse<UploadMaterialResponse> = response.json;
            
            console.log('[飞书API] 文件上传响应:', {
                status: response.status,
                code: result.code,
                msg: result.msg,
                hasData: !!result.data,
                fileToken: result.data?.file_token
            });
            
            if (result.code !== 0) {
                console.error('[飞书API] 上传文件失败，错误详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`上传文件失败: [${result.code}] ${result.msg}`);
            }
            
            if (!result.data || !result.data.file_token) {
                console.error('[飞书API] 响应中缺少file_token:', result);
                throw new Error('上传成功但未返回file_token');
            }
            
            console.log('[飞书API] 文件上传成功，file_token:', result.data.file_token);
            return result.data.file_token;
        } catch (error) {
            console.error('[飞书API] 上传文件到飞书失败:', {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
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
        console.log('[飞书API] 🚀 调用uploadImageMaterial API');
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
            console.log('[飞书API] 开始上传图片素材:', {
                fileName,
                documentId,
                url,
                hasToken: !!token,
                tokenPrefix: token ? token.substring(0, 10) + '...' : 'null',
                boundary,
                bodySize: body.byteLength
            });
            
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            this.apiCallCountCallback?.();
            
            console.log('[飞书API] 上传图片素材响应:', {
                status: response.status,
                headers: response.headers,
                hasJson: !!response.json
            });
            
            const result: FeishuApiResponse<UploadMaterialResponse> = response.json;
            
            console.log('[飞书API] 上传图片素材结果:', {
                code: result.code,
                msg: result.msg,
                hasData: !!result.data,
                fullResponse: result
            });
            
            if (result.code !== 0) {
                console.error('[飞书API] 上传图片素材失败，错误详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`上传图片素材失败: [${result.code}] ${result.msg}`);
            }
            
            if (!result.data || !result.data.file_token) {
                console.error('[飞书API] 响应中缺少file_token:', result);
                throw new Error('上传成功但未返回file_token');
            }
            
            console.log('[飞书API] 图片素材上传成功，file_token:', result.data.file_token);
            return result.data.file_token;
        } catch (error) {
            console.error('[飞书API] 上传图片素材到飞书失败:', {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
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
        console.log('[飞书API] 🚀 调用createImportTask API');
        console.log('[飞书API] 开始创建导入任务:', {
            fileName,
            fileToken: fileToken ? `${fileToken.substring(0, 10)}...` : 'null',
            folderToken: folderToken ? `${folderToken.substring(0, 10)}...` : 'null'
        });
        
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
        
        const requestBody: any = {
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
        
        console.log('[飞书API] 创建导入任务请求参数:', {
            url,
            requestBody: {
                ...requestBody,
                file_token: requestBody.file_token ? `${requestBody.file_token.substring(0, 10)}...` : 'null'
            }
        });
        
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
            console.log('[飞书API] 创建导入任务响应:', {
                status: response.status,
                headers: response.headers,
                hasData: !!response.json
            });
            
            const result: FeishuApiResponse<ImportTaskResponse> = response.json;
            console.log('[飞书API] 创建导入任务结果:', {
                code: result.code,
                msg: result.msg,
                hasData: !!result.data,
                ticket: result.data?.ticket ? `${result.data.ticket.substring(0, 10)}...` : 'null'
            });
            
            // 飞书API返回code==0表示成功
            if (result.code === 0) {
                if (!result.data?.ticket) {
                    console.error('[飞书API] 创建导入任务成功但缺少ticket');
                    throw new Error('创建导入任务成功但返回数据中缺少ticket');
                }
                
                console.log('[飞书API] 创建导入任务成功，获得ticket:', {
                    ticket: result.data.ticket ? `${result.data.ticket.substring(0, 10)}...` : 'null'
                });
                return result.data.ticket;
            } else {
                console.error('[飞书API] 创建导入任务失败，错误详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`创建导入任务失败 (错误码: ${result.code}): ${result.msg}`);
            }
        } catch (error: any) {
            // 如果是HTTP错误，尝试获取响应体中的详细错误信息
            if (error.status === 400 && error.json) {
                console.error('[飞书API] HTTP 400错误，详细响应:', {
                    status: error.status,
                    responseBody: error.json,
                    headers: error.headers
                });
                const errorResult = error.json;
                if (errorResult.code && errorResult.msg) {
                    throw new Error(`创建导入任务失败 (错误码: ${errorResult.code}): ${errorResult.msg}`);
                }
            }
            
            console.error('[飞书API] 创建飞书导入任务失败:', {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
                requestUrl: url,
                hasToken: !!token,
                status: error.status || 'unknown',
                responseBody: error.json || 'no response body'
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
        
        console.log('[飞书API] 查询导入任务:', {
            ticket,
            url,
            tokenValue: token, // 打印实际的token值
            hasToken: !!token
        });
        
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
            console.log('[飞书API] 查询导入任务响应 (原始):', response.json); // 打印原始响应
            const result: FeishuApiResponse<any> = response.json;
            
            console.log('[飞书API] 查询导入任务响应:', {
                status: response.status,
                code: result.code,
                msg: result.msg,
                hasData: !!result.data,
                fullResponse: result
            });
            
            if (result.code !== 0) {
                console.error('[飞书API] 查询导入任务失败，错误详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`查询导入任务失败: [${result.code}] ${result.msg}`);
            }
            
            // 根据实际返回的数据结构解析结果
            // 飞书API返回的数据结构是 data.result，而不是直接的 data
            const taskResult = result.data?.result || result.data;
            
            console.log('[飞书API] 导入任务状态:', {
                job_status: taskResult.job_status,
                job_error_msg: taskResult.job_error_msg,
                token: taskResult.token,
                url: taskResult.url,
                fullResult: taskResult,
                rawData: result.data
            });
            
            return taskResult;
        } catch (error) {
            console.error('[飞书API] 查询导入任务异常:', {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
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
                
                console.log(`[飞书API] 🔍 查询导入任务状态 (第${retryCount + 1}次):`, {
                    ticket,
                    job_status: result.job_status,
                    job_status_meaning: result.job_status === 0 ? '成功' : result.job_status === 1 ? '进行中' : result.job_status === 2 ? '处理中' : '未知',
                    job_error_msg: result.job_error_msg,
                    hasToken: !!result.token,
                    hasUrl: !!result.url,
                    fullResult: result
                });
                
                if (result.job_status === 0) {
                    // 成功完成
                    console.log(`[飞书API] ✅ 导入任务成功完成:`, {
                        job_status: result.job_status,
                        token: result.token,
                        url: result.url,
                        hasToken: !!result.token,
                        hasUrl: !!result.url,
                        fullResult: result
                    });
                    
                    if (!result.token || !result.url) {
                        console.error('[飞书API] ❌ 导入任务完成但缺少必要信息:', result);
                        throw new Error('导入任务完成但未返回文档信息');
                    }
                    
                    // 验证和格式化URL
                    const formattedUrl = this.formatDocumentUrl(result.url, result.token);
                    console.log(`[飞书API] 📄 格式化后的文档URL:`, {
                        originalUrl: result.url,
                        formattedUrl: formattedUrl,
                        token: result.token
                    });
                    
                    return {
                        token: result.token,
                        url: formattedUrl
                    };
                } else if (result.job_status === 1 || result.job_status === 2) {
                    // 任务进行中 (job_status === 1) 或处理中 (job_status === 2)
                    retryCount++;
                    console.log(`[飞书API] 导入任务${result.job_status === 1 ? '进行中' : '处理中'}，第${retryCount}次检查`);
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
                    
                    console.log(`[飞书API] 等待${waitTime/1000}秒后进行第${retryCount + 1}次重试...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    
                    // 继续循环重试
                    continue;
                } else {
                    // 未知状态或其他错误状态
                    console.error('[飞书API] 导入任务状态未知:', {
                        job_status: result.job_status,
                        job_error_msg: result.job_error_msg,
                        fullResult: result
                    });
                    
                    const errorMsg = result.job_error_msg || `未知的任务状态: ${result.job_status}`;
                    throw new Error(`导入任务失败: ${errorMsg}`);
                }
                
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`[飞书API] ⚠️ waitForImportTask异常 (第${retryCount + 1}次):`, {
                    error: errorMessage,
                    retryCount,
                    maxRetries,
                    willRetry: retryCount < maxRetries,
                    fullError: error
                });
                
                // 如果是任务失败或进行中的错误，直接抛出，不重试
                if (errorMessage.includes('导入任务失败') || errorMessage.includes('导入任务已提交')) {
                    console.error(`[飞书API] 💥 任务状态错误，不再重试`);
                    throw error;
                }
                
                // 只有网络错误或其他异常才重试
                retryCount++;
                if (retryCount > maxRetries) {
                    console.error(`[飞书API] 💥 已达到最大重试次数 (${maxRetries})，停止重试`);
                    throw error;
                }
                
                // 计算递增等待时间：3秒 → 3秒 → 6秒 → 6秒 → 6秒
                let waitTime = 3000; // 默认3秒
                if (retryCount >= 3) {
                    waitTime = 6000; // 第3次及以后等待6秒
                }
                
                console.log(`[飞书API] 🔄 等待${waitTime/1000}秒后进行第${retryCount + 1}次重试...`);
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
        
        console.log('[飞书API] 开始获取文档块:', {
            documentId,
            url,
            hasToken: !!token
        });
        
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
            
            console.log('[飞书API] 获取文档块响应:', {
                status: response.status,
                headers: response.headers,
                hasJson: !!response.json
            });
            
            const result: FeishuApiResponse<DocumentBlocksResponse> = response.json;
            
            console.log('[飞书API] 获取文档块结果:', {
                code: result.code,
                msg: result.msg,
                hasData: !!result.data,
                itemsCount: result.data?.items?.length || 0,
                fullResponse: result
            });
            
            if (result.code !== 0) {
                console.error('[飞书API] 获取文档块失败，错误详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`获取文档块失败: [${result.code}] ${result.msg}`);
            }
            
            if (!result.data || !result.data.items) {
                console.error('[飞书API] 响应中缺少items:', result);
                throw new Error('获取成功但未返回文档块数据');
            }
            
            console.log('[飞书API] 文档块获取成功，共', result.data.items.length, '个块');
            return result.data.items;
        } catch (error) {
            console.error('[飞书API] 获取文档块失败:', {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
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
                const dimensions = await this.getImageDimensions(imageInfo.path);
                if (dimensions) {
                    width = dimensions.width;
                    height = dimensions.height;
                    
                    // 如果图片过大，按比例缩放到合适尺寸
                    const maxWidth = 1200;
                    const maxHeight = 800;
                    
                    if (width > maxWidth || height > maxHeight) {
                        const ratio = Math.min(maxWidth / width, maxHeight / height);
                        width = Math.round(width * ratio);
                        height = Math.round(height * ratio);
                    }
                }
            } catch (error) {
                console.warn('[飞书API] 获取图片尺寸失败，使用默认尺寸:', error);
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
        
        console.log('[飞书API] 开始更新文档块:', {
            documentId,
            blockId,
            imageToken: imageToken ? `${imageToken.substring(0, 10)}...` : 'null',
            url,
            hasToken: !!token,
            requestBody
        });
        
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
            
            console.log('[飞书API] 更新文档块响应:', {
                status: response.status,
                headers: response.headers,
                hasJson: !!response.json
            });
            
            const result: FeishuApiResponse<any> = response.json;
            
            console.log('[飞书API] 更新文档块结果:', {
                code: result.code,
                msg: result.msg,
                hasData: !!result.data,
                fullResponse: result
            });
            
            if (result.code !== 0) {
                console.error('[飞书API] 更新文档块失败，错误详情:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`更新文档块失败: [${result.code}] ${result.msg}`);
            }
            
            console.log('[飞书API] 文档块更新成功');
        } catch (error) {
            console.error('[飞书API] 更新文档块失败:', {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
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
            console.log('[飞书API] 没有图片需要处理');
            return;
        }
        
        console.log('[飞书API] 开始处理文档中的图片:', {
            documentId,
            imageCount: imageInfos.length,
            images: imageInfos.map(img => ({ fileName: img.fileName, path: img.path }))
        });
        
        try {
            // 步骤一：获取文档所有块
            onProgress?.('正在获取文档结构...');
            const blocks = await this.getDocumentBlocks(documentId);
            
            // 找到图片块
            const imageBlocks = blocks.filter(block => block.block_type === 27); // 27表示图片块
            console.log('[飞书API] 找到图片块:', imageBlocks.length, '个');
            
            if (imageBlocks.length === 0) {
                console.log('[飞书API] 文档中没有图片块，无需处理');
                return;
            }
            
            // 步骤二：按顺序上传图片并更新块
            for (let i = 0; i < imageInfos.length && i < imageBlocks.length; i++) {
                const imageInfo = imageInfos[i];
                const imageBlock = imageBlocks[i];
                
                if (!imageInfo || !imageBlock) {
                    console.warn(`[飞书API] 跳过无效的图片或块: ${i}`);
                    continue;
                }
                
                onProgress?.(`正在处理图片 ${i + 1}/${imageInfos.length}: ${imageInfo.fileName}`);
                
                try {
                    // 读取本地图片文件并转换为base64
                    const fileContent = await this.readImageFileAsBase64(imageInfo.path);
                    if (!fileContent) {
                        throw new Error(`无法读取图片文件: ${imageInfo.path}`);
                    }
                    
                    // 上传图片素材
                    console.log(`[飞书API] 上传图片素材: ${imageInfo.fileName}`);
                    const fileToken = await this.uploadImageMaterial(
                        imageInfo.fileName, 
                        fileContent, 
                        documentId,
                        imageBlock.block_id
                    );
                    
                    // 更新文档块
                    console.log(`[飞书API] 更新文档块: ${imageBlock.block_id}`);
                    await this.updateDocumentBlock(
                        documentId, 
                        imageBlock.block_id, 
                        fileToken,
                        imageInfo
                    );
                    
                    console.log(`[飞书API] 图片 ${imageInfo.fileName} 处理完成`);
                    
                } catch (error) {
                    console.error(`[飞书API] 处理图片 ${imageInfo.fileName} 失败:`, error);
                    // 继续处理下一张图片，不中断整个流程
                    onProgress?.(`图片 ${imageInfo.fileName} 处理失败: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            
            onProgress?.('所有图片处理完成！');
            console.log('[飞书API] 文档图片处理流程完成');
            
        } catch (error) {
            console.error('[飞书API] 图片处理流程失败:', {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
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
                const fileName = imagePath.split(/[\/\\]/).pop();
                if (fileName) {
                    fullPath = fileName;
                }
            } else {
                // 移除开头的 ./ 如果存在
                fullPath = imagePath.replace(/^\.\//, '');
            }
            
            // 在Obsidian中查找图片文件
            const file = await this.searchImageInVault(fullPath);
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
            console.error('[飞书API] 获取图片尺寸失败:', error);
            return null;
        }
    }
    
    /**
     * 读取本地图片文件并转换为base64
     * @param imagePath 图片文件路径
     * @returns base64编码的图片内容
     */
    private async readImageFileAsBase64(imagePath: string): Promise<string | null> {
        try {
            // 处理相对路径，转换为绝对路径
            let fullPath = imagePath;
            
            // 如果是绝对路径，提取文件名进行搜索
            if (imagePath.match(/^[A-Za-z]:/) || imagePath.startsWith('/')) {
                const fileName = imagePath.split(/[\\/]/).pop();
                if (fileName) {
                    fullPath = fileName;
                }
            } else {
                // 移除开头的 ./ 如果存在
                fullPath = imagePath.replace(/^\.\//,  '');
            }
            
            console.log('[飞书API] 尝试读取图片文件:', {
                originalPath: imagePath,
                fullPath: fullPath
            });
            
            // 首先尝试直接路径查找
            let file = this.app?.vault?.getAbstractFileByPath(fullPath);
            
            // 如果直接路径找不到，在整个vault中搜索同名文件
            if (!file) {
                console.log('[飞书API] 直接路径未找到，开始在vault中搜索文件:', fullPath);
                file = await this.searchImageInVault(fullPath);
            }
            
            if (!file) {
                console.error('[飞书API] 找不到图片文件:', fullPath);
                return null;
            }
            
            // 检查是否为文件（而非文件夹）
            if (!('extension' in file)) {
                console.error('[飞书API] 路径不是有效的文件:', file.path);
                return null;
            }
            
            // 读取文件内容为ArrayBuffer
            const arrayBuffer = await this.app.vault.readBinary(file as any);
            
            // 转换为base64
            const uint8Array = new Uint8Array(arrayBuffer);
            const binaryString = Array.from(uint8Array, byte => String.fromCharCode(byte)).join('');
            const base64Content = btoa(binaryString);
            
            console.log('[飞书API] 图片文件读取成功:', {
                path: file.path,
                size: arrayBuffer.byteLength,
                base64Length: base64Content.length
            });
            
            return base64Content;
            
        } catch (error) {
            console.error('[飞书API] 读取图片文件失败:', {
                path: imagePath,
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
    }
    
    /**
     * 在整个vault中搜索图片文件
     * @param fileName 文件名或路径
     * @returns 找到的文件对象
     */
    private async searchImageInVault(fileName: string): Promise<any> {
        if (!this.app?.vault) {
            return null;
        }
        
        // 提取纯文件名（去除路径）
        const targetFileName = fileName.split(/[\\/]/).pop();
        if (!targetFileName) {
            return null;
        }
        
        console.log('[飞书API] 在vault中搜索图片文件:', targetFileName);
        
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
                console.log('[飞书API] 找到匹配的图片文件:', file.path);
                return file;
            }
            
            // 如果目标文件名没有扩展名，尝试匹配基础名称
            if (!targetFileName.includes('.')) {
                const fileBaseName = file.name.substring(0, file.name.lastIndexOf('.'));
                if (fileBaseName === targetFileName) {
                    console.log('[飞书API] 通过基础名称找到匹配的图片文件:', file.path);
                    return file;
                }
            }
        }
        
        console.log('[飞书API] 在vault中未找到图片文件:', targetFileName);
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
        let convertCount = 0;
        
        // 重置正则表达式的lastIndex
        obsidianImageRegex.lastIndex = 0;
        
        while ((match = obsidianImageRegex.exec(markdownContent)) !== null) {
            const fileName = match[1]; // 图片文件名
            const altText = match[2] || fileName; // alt文本，如果没有指定则使用文件名
            const obsidianSyntax = match[0]; // 完整的Obsidian语法
            
            // 转换为标准Markdown语法: ![alt](filename)
            const standardSyntax = `![${altText}](${fileName})`;
            
            // 替换内容
            convertedContent = convertedContent.replace(obsidianSyntax, standardSyntax);
            convertCount++;
            
            console.log('[飞书API] 转换图片语法:', {
                from: obsidianSyntax,
                to: standardSyntax,
                fileName,
                altText
            });
        }
        
        if (convertCount > 0) {
            console.log(`[飞书API] 图片语法转换完成，共转换 ${convertCount} 个图片`);
        } else {
            console.log('[飞书API] 未发现需要转换的Obsidian图片语法');
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
        const markdownImageRegex = /!\[([^\]]*)\]\(([^\)\s]+)(?:\s+"([^"]*)")?\)/g;
        
        let match;
        let position = 0;
        
        // 处理标准Markdown格式的图片（现在包括转换后的Obsidian图片）
        while ((match = markdownImageRegex.exec(convertedContent)) !== null) {
            const alt = match[1];
            const path = match[2];
            const title = match[3];
            
            if (!path) continue;
            
            // 提取文件名
            const fileName = path.split('/').pop() || path;
            const fullPath = basePath && !path.startsWith('http') ? `${basePath}/${path}` : path;
            
            imageInfos.push({
                path: fullPath,
                fileName: fileName,
                position: position++
            });
        }
        
        console.log('[飞书API] 从Markdown中提取到图片:', imageInfos.length, '张');
        return imageInfos;
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
            const fileContent = btoa(unescape(encodeURIComponent(convertedContent)));
            
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
            console.error('直接上传文件失败:', error);
            throw error;
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
            const fileContent = btoa(unescape(encodeURIComponent(convertedContent)));
            
            // 先上传文件到云空间获取file_token（使用完整文件名包含扩展名）
            mdFileToken = await this.uploadFile(fileName, fileContent, documentId || '');
            console.log('[飞书API] MD文件已上传，file_token:', mdFileToken);
            
            onProgress?.('文件已上传，正在创建导入任务...');
            
            // 使用file_token创建导入任务（传递完整文件名，方法内部会处理扩展名分离）
            const ticket = await this.createImportTask(fileName, mdFileToken, documentId || '');
            
            onProgress?.('任务已创建，正在处理...');
            
            // 等待3秒让飞书开始处理任务，减少API调用次数
            console.log('[飞书API] 等待3秒让飞书开始处理任务...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            onProgress?.('开始查询处理状态...');
            
            // 等待任务完成
            const result = await this.waitForImportTask(ticket, onProgress);
            
            // 检查是否有图片需要处理
            const imageInfos = FeishuApiClient.extractImageInfoFromMarkdown(markdownContent, this.app?.vault?.adapter?.basePath);
            if (imageInfos.length > 0) {
                onProgress?.('正在处理文档中的图片...');
                await this.processImagesInDocument(result.token, imageInfos, onProgress);
            }
            
            // 转换完成后，静默删除MD文件（用户不会察觉）
            if (mdFileToken) {
                try {
                    console.log('[飞书API] 开始清理临时MD文件，file_token:', mdFileToken);
                    await this.deleteFile(mdFileToken, 'file');
                    console.log('[飞书API] 临时MD文件已清理');
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
                    console.log('[飞书API] 主流程失败，尝试清理临时MD文件');
                    await this.deleteFile(mdFileToken, 'file');
                } catch (deleteError) {
                    console.warn('[飞书API] 清理临时MD文件失败:', deleteError);
                }
            }
            
            console.error('上传文档失败:', error);
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
            console.error('测试飞书API连接失败:', error);
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
                console.log('[飞书API] URL已经是完整格式，直接返回:', url);
                return url;
            }
            
            // 如果URL是相对路径或只有token，构造完整的飞书文档URL
            if (!url.startsWith('http')) {
                // 根据飞书API文档，文档URL格式为：https://[domain]/docs/[doc_token]
                // 这里使用飞书的标准文档访问格式
                const formattedUrl = `https://open.feishu.cn/document/${token}`;
                console.log('[飞书API] 构造飞书文档URL:', {
                    originalUrl: url,
                    token: token,
                    formattedUrl: formattedUrl
                });
                return formattedUrl;
            }
            
            // 如果URL格式不正确，尝试修复
            console.log('[飞书API] URL格式需要验证:', url);
            return url;
            
        } catch (error) {
            console.error('[飞书API] URL格式化失败:', error);
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
        
        console.log('[飞书API] 转移文档所有权:', {
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
            
            console.log('[飞书API] 所有权转移请求参数:', {
                url: transferUrl,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token.substring(0, 20)}...`,
                    'Content-Type': 'application/json'
                },
                requestBody,
                bodyString: JSON.stringify(requestBody)
            });
            
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            this.apiCallCountCallback?.();
            const result: FeishuApiResponse<any> = response.json;
            
            console.log('[飞书API] 所有权转移响应:', {
                status: response.status,
                code: result.code,
                msg: result.msg,
                fullResponse: result
            });
            
            if (result.code === 0) {
                console.log('[飞书API] ✅ 文档所有权转移成功');
                return true;
            } else {
                console.error('[飞书API] ❌ 文档所有权转移失败:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`转移文档所有权失败: [${result.code}] ${result.msg}`);
            }
            
        } catch (error: any) {
            console.error('[飞书API] ❌ 所有权转移异常:', {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                status: error.status,
                statusText: error.statusText,
                response: error.response,
                json: error.json
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
        
        // 调试：检查令牌状态
        const now = Date.now();
        console.log('[飞书API] 令牌状态检查:', {
            hasToken: !!this.accessToken,
            tokenLength: this.accessToken?.length || 0,
            tokenPrefix: this.accessToken?.substring(0, 20) + '...',
            currentTime: new Date(now).toISOString(),
            expireTime: new Date(this.tokenExpireTime).toISOString(),
            timeUntilExpire: this.tokenExpireTime - now,
            isExpired: now >= this.tokenExpireTime
        });
        
        console.log('[飞书API] 设置文档权限:', {
            docToken,
            permissions,
            userId
        });
        
        try {
            // 第零步：如果提供了用户ID，先转移文档所有权
            if (userId) {
                console.log('[飞书API] 第零步：转移文档所有权给用户');
                await this.transferDocumentOwnership(docToken, userId);
                
                // 等待1秒让所有权转移生效
                console.log('[飞书API] 等待1秒让所有权转移生效...');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // 一次性设置所有权限
            const requestBody: any = {
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
            
            console.log('[飞书API] 设置所有权限', {
                requestBody,
                bodyString: JSON.stringify(requestBody)
            });
            
            const publicUrl = `${this.baseUrl}/drive/v2/permissions/${docToken}/public?type=docx`;
            
            // 一次性设置所有权限
            await this.executePermissionRequest(publicUrl, token, requestBody, '权限设置');
            
            console.log('[飞书API] ✅ 所有权限设置完成');
            return true;
            
        } catch (error: any) {
            console.error('[飞书API] ❌ 权限设置失败:', {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                status: error.status,
                statusText: error.statusText,
                response: error.response,
                json: error.json
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
        
        console.log('[飞书API] 仅更新文档权限:', {
            docToken,
            permissions
        });
        
        try {
            // 一次性设置所有权限
            const requestBody: any = {
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
            
            console.log('[飞书API] 设置权限（无所有权转移）', {
                requestBody,
                bodyString: JSON.stringify(requestBody)
            });
            
            const publicUrl = `${this.baseUrl}/drive/v2/permissions/${docToken}/public?type=docx`;
            
            // 一次性设置所有权限
            await this.executePermissionRequest(publicUrl, token, requestBody, '权限设置（无所有权转移）');
            
            console.log('[飞书API] ✅ 权限设置完成（无所有权转移）');
            return true;
            
        } catch (error: any) {
            console.error('[飞书API] ❌ 权限设置失败（无所有权转移）:', {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                status: error.status,
                statusText: error.statusText,
                response: error.response,
                json: error.json
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
        requestBody: any, 
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
                
                console.log(`[飞书API] ${stepName}请求 (第${retryCount + 1}次):`, {
                    url,
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Bearer ${token.substring(0, 20)}...`,
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    requestBody,
                    bodyString: JSON.stringify(requestBody)
                });
                
                const response = await requestUrl(requestParam);
                // 增加API调用计数
                this.apiCallCountCallback?.();
                const result: FeishuApiResponse<any> = response.json;
                
                console.log(`[飞书API] ${stepName}响应 (第${retryCount + 1}次):`, {
                    status: response.status,
                    code: result.code,
                    msg: result.msg,
                    fullResponse: result
                });
                
                if (result.code === 0) {
                    console.log(`[飞书API] ✅ ${stepName}成功`);
                    return;
                } else {
                    // 业务错误，不重试
                    console.error(`[飞书API] ❌ ${stepName}失败:`, {
                        code: result.code,
                        msg: result.msg,
                        fullResult: result
                    });
                    throw new Error(`${stepName}失败: [${result.code}] ${result.msg}`);
                }
                
            } catch (error: any) {
                console.error(`[飞书API] ❌ ${stepName}第${retryCount + 1}次请求异常:`, {
                    error,
                    errorMessage: error instanceof Error ? error.message : String(error),
                    status: error.status,
                    statusText: error.statusText,
                    response: error.response,
                    json: error.json,
                    retryCount,
                    maxRetries
                });

                // 检查是否是500错误
                if (error.status === 500 && retryCount < maxRetries) {
                    retryCount++;
                    console.warn(`[飞书API] ⚠️ ${stepName}遇到500错误，${retryDelay/1000}秒后进行第${retryCount + 1}次重试...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                } else {
                    // 非500错误或已达到最大重试次数
                    console.error(`[飞书API] ❌ ${stepName}最终失败:`, {
                        error,
                        errorMessage: error instanceof Error ? error.message : String(error),
                        status: error.status,
                        statusText: error.statusText,
                        response: error.response,
                        json: error.json,
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
        
        console.log('[飞书API] 删除文件:', {
            docToken,
            fileType
        });
        
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
            
            console.log('[飞书API] 删除文件请求参数:', {
                url: deleteUrl,
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token.substring(0, 20)}...`,
                    'Content-Type': 'application/json; charset=utf-8'
                }
            });
            
            const response = await requestUrl(requestParam);
            // 增加API调用计数
            this.apiCallCountCallback?.();
            const result: FeishuApiResponse<any> = response.json;
            
            console.log('[飞书API] 删除文件响应:', {
                status: response.status,
                code: result.code,
                msg: result.msg,
                fullResponse: result
            });
            
            if (result.code === 0) {
                console.log('[飞书API] ✅ 文件删除成功');
                return true;
            } else {
                console.error('[飞书API] ❌ 文件删除失败:', {
                    code: result.code,
                    msg: result.msg,
                    fullResult: result
                });
                throw new Error(`删除文件失败: [${result.code}] ${result.msg}`);
            }
            
        } catch (error: any) {
            console.error('[飞书API] ❌ 删除文件异常:', {
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                status: error.status,
                statusText: error.statusText,
                response: error.response,
                json: error.json
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
     * 获取文档所有块的详细信息（支持 Callout 转换）
     * @param documentId 文档ID
     * @returns 文档块数组（包含完整的块信息）
     */
    async getDocumentBlocksDetailed(documentId: string): Promise<any[]> {
        try {
            const token = await this.getAccessToken();
            const allBlocks: any[] = [];
            let pageToken: string | undefined;
            let hasMore = true;

            while (hasMore) {
                const url = `${this.baseUrl}/docx/v1/documents/${documentId}/blocks`;
                const params: any = {
                    page_size: 500,
                    user_id_type: 'user_id'
                };
                
                if (pageToken) {
                    params.page_token = pageToken;
                }

                const requestParam: RequestUrlParam = {
                    url: url + '?' + new URLSearchParams(params).toString(),
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                };

                console.log('[飞书API] 获取文档块详细信息:', {
                    documentId,
                    pageToken,
                    url: requestParam.url
                });

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

                console.log('[飞书API] 获取文档块详细信息成功:', {
                    currentBatch: result.data.items.length,
                    totalSoFar: allBlocks.length,
                    hasMore
                });
            }

            return allBlocks;
        } catch (error) {
            console.error('[飞书API] 获取文档块详细信息失败:', {
                documentId,
                error,
                errorMessage: error instanceof Error ? error.message : String(error)
            });
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
        requests: Array<{
            block_id?: string;
            parent_id?: string;
            index?: number;
            insert_block?: any;
            update_text_elements?: {
                elements: Array<{
                    text_run?: {
                        content: string;
                        text_element_style?: any;
                    };
                    mention_doc?: any;
                    equation?: any;
                }>;
            };
            merge_table_cells?: any;
            unmerge_table_cells?: any;
            replace_image?: any;
        }>
    ): Promise<any> {
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

            console.log('[飞书API] 批量更新文档块:', {
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
            const result: FeishuApiResponse<any> = response.json;

            if (result.code !== 0) {
                throw new Error(`批量更新文档块失败: ${result.msg}`);
            }

            console.log('[飞书API] 批量更新文档块成功:', {
                documentId,
                updatedCount: requests.length,
                result: result.data
            });

            return result.data;
        } catch (error) {
            console.error('[飞书API] 批量更新文档块失败:', {
                documentId,
                requestCount: requests.length,
                error,
                errorMessage: error instanceof Error ? error.message : String(error)
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
        children: any[]
    ): Promise<any> {
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

            console.log('[飞书API] 创建文档块:', {
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
            const result: FeishuApiResponse<any> = response.json;

            console.log('[飞书API] 创建文档块原始响应:', {
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
                console.error('[飞书API] 创建文档块详细错误信息:', errorDetails);
                throw new Error(`创建文档块失败: ${result.msg} (code: ${result.code})`);
            }

            console.log('[飞书API] 创建文档块成功:', {
                documentId,
                parentId,
                index,
                result: result.data
            });

            return result.data;
        } catch (error) {
            console.error('[飞书API] 创建文档块失败:', {
                documentId,
                parentId,
                index,
                childrenCount: children.length,
                requestUrl: `${this.baseUrl}/docx/v1/documents/${documentId}/blocks/${parentId}/children?document_revision_id=-1`,
                requestBody: {
                    index,
                    children
                },
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined
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
        descendants: any[]
    ): Promise<any> {
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

            console.log('[飞书API] 创建嵌套文档块:', {
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
            const result: FeishuApiResponse<any> = response.json;

            console.log('[飞书API] 创建嵌套文档块原始响应:', {
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
                console.error('[飞书API] 创建嵌套文档块详细错误信息:', errorDetails);
                throw new Error(`创建嵌套文档块失败: ${result.msg} (code: ${result.code})`);
            }

            console.log('[飞书API] 创建嵌套文档块成功:', {
                documentId,
                parentId,
                index,
                result: result.data
            });

            return result.data;
        } catch (error) {
            console.error('[飞书API] 创建嵌套文档块失败:', {
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
                },
                error,
                errorMessage: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined
            });
            throw error;
        }
    }

    /**
     * 删除文档块
     * @param documentId 文档ID
     * @param blockId 块ID
     * @returns 删除结果
     */
    async deleteDocumentBlock(documentId: string, blockId: string, parentId?: string, index?: number): Promise<any> {
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

                console.log('[飞书API] 删除文档块:', {
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
                const result: FeishuApiResponse<any> = response.json;

                if (result.code !== 0) {
                    throw new Error(`删除文档块失败: ${result.msg}`);
                }

                console.log('[飞书API] 删除文档块成功:', {
                    documentId,
                    blockId,
                    result: result.data
                });

                return result.data;
            } catch (error) {
                console.error('[飞书API] 删除文档块失败:', {
                    documentId,
                    blockId,
                    error,
                    errorMessage: error instanceof Error ? error.message : String(error)
                });
                throw error;
            }
        });
    }

    /**
     * 转换 Markdown 为文档块（支持 Callout 检测）
     * @param content Markdown 内容
     * @returns 转换结果
     */
    async convertMarkdownToBlocks(content: string): Promise<any> {
        try {
            const token = await this.getAccessToken();
            const url = `${this.baseUrl}/docx/v1/documents/content/blocks`;

            const requestBody = {
                content: content,
                format: 'markdown'
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

            console.log('[飞书API] 转换 Markdown 为文档块:', {
                contentLength: content.length,
                contentPreview: content.substring(0, 100) + (content.length > 100 ? '...' : '')
            });

            if (this.apiCallCountCallback) {
                this.apiCallCountCallback();
            }

            const response = await requestUrl(requestParam);
            const result: FeishuApiResponse<any> = response.json;

            if (result.code !== 0) {
                throw new Error(`转换 Markdown 失败: ${result.msg}`);
            }

            console.log('[飞书API] 转换 Markdown 成功:', {
                blocksCount: result.data?.blocks?.length || 0
            });

            return result.data;
        } catch (error) {
            console.error('[飞书API] 转换 Markdown 失败:', {
                contentLength: content.length,
                error,
                errorMessage: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }
}

/**
 * 创建飞书API客户端实例
 */
export function createFeishuClient(appId: string, appSecret: string, app?: any, apiCallCountCallback?: () => void): FeishuApiClient {
    return new FeishuApiClient(appId, appSecret, app, apiCallCountCallback);
}