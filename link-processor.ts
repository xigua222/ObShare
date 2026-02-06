import { App, TFile, Vault } from 'obsidian';
import { FeishuApiClient } from './feishu-api';

/**
 * 双链信息接口
 */
export interface WikiLinkInfo {
    /** 原始双链文本 */
    originalText: string;
    /** 链接的文档标题 */
    title: string;
    /** 在文档中的位置 */
    position: number;
    /** 对应的文件对象 */
    file?: TFile;
    /** 上传后的飞书文档链接 */
    feishuUrl?: string;
    /** 上传后的飞书文档token */
    feishuToken?: string;
}

/**
 * 上传结果接口
 */
export interface UploadResult {
    /** 文档token */
    token: string;
    /** 文档URL */
    url: string;
    /** 文档标题 */
    title: string;
}

type LinkProcessorPluginContext = {
    settings: {
        folderToken: string;
    };
    updateHistoryPermissions?: (docToken: string, permissions: {
        isPublic: boolean;
        allowCopy: boolean;
        allowCreateCopy: boolean;
    }) => Promise<void> | void;
};

/**
 * 双链处理器类
 * 负责处理Obsidian双链格式的笔记上传
 */
export class LinkProcessor {
    private app: App;
    private vault: Vault;
    private feishuClient: FeishuApiClient;
    private plugin: LinkProcessorPluginContext;
    private uploadedDocuments: Map<string, UploadResult> = new Map(); // 缓存已上传的文档
    private processingDocuments: Set<string> = new Set(); // 正在处理的文档，防止循环引用
    private static debugEnabled = false;

    static setDebugEnabled(enabled: boolean): void {
        this.debugEnabled = enabled;
    }

    private debug(...args: unknown[]): void {
        if (LinkProcessor.debugEnabled) {
            console.debug(...args);
        }
    }

    private logError(summary: string, error: unknown, details?: Record<string, unknown>): void {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(summary, errorMessage);
        this.debug(`${summary} 详情:`, {
            ...details,
            error,
            errorMessage,
            errorStack: error instanceof Error ? error.stack : undefined
        });
    }

    constructor(app: App, feishuClient: FeishuApiClient, plugin: LinkProcessorPluginContext) {
        this.app = app;
        this.vault = app.vault;
        this.feishuClient = feishuClient;
        this.plugin = plugin;
    }

    /**
     * 从Markdown内容中提取所有双链引用
     * @param content Markdown内容
     * @returns 双链信息数组
     */
    extractWikiLinks(content: string): WikiLinkInfo[] {
        const wikiLinks: WikiLinkInfo[] = [];
        
        // 匹配Obsidian双链格式: [[文档标题]] 或 [[文档标题|显示文本]]
        const wikiLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
        
        let match;
        while ((match = wikiLinkRegex.exec(content)) !== null) {
            if (!match[1]) continue; // 跳过无效匹配
            
            const title = match[1].trim(); // 文档标题
            const displayText = match[2] || title; // 显示文本，如果没有指定则使用标题
            const originalText = match[0]; // 完整的双链语法
            const position = match.index; // 在内容中的位置
            
            // 查找对应的文件
            const file = this.findFileByTitle(title);
            
            wikiLinks.push({
                originalText,
                title,
                position,
                ...(file && { file }) // 只有当file存在时才添加file属性
            });
            

        }
        
        return wikiLinks;
    }

    /**
     * 根据标题查找文件
     * @param title 文档标题
     * @returns 对应的文件对象或null
     */
    private findFileByTitle(title: string): TFile | null {
        // 获取所有markdown文件
        const files = this.vault.getMarkdownFiles();
        
        // 1. 精确匹配：文件名（不含扩展名）等于标题
        let matchedFile = files.find(file => file.basename === title);
        if (matchedFile) return matchedFile;
        
        // 2. 路径匹配：支持带路径的引用，如 "folder/filename"
        matchedFile = files.find(file => {
            const pathWithoutExt = file.path.replace(/\.md$/, '');
            return pathWithoutExt === title || pathWithoutExt.endsWith('/' + title);
        });
        if (matchedFile) return matchedFile;
        
        // 3. 模糊匹配：标题包含在文件名中或文件名包含在标题中
        matchedFile = files.find(file => {
            const baseName = file.basename.toLowerCase();
            const titleLower = title.toLowerCase();
            return baseName.includes(titleLower) || titleLower.includes(baseName);
        });
        if (matchedFile) return matchedFile;
        
        return null;
    }

    /**
     * 递归上传引用的文档
     * @param wikiLinks 双链信息数组
     * @param onProgress 进度回调
     * @param applyPermissions 是否应用权限设置（与主文档保持一致）
     * @param permissions 权限设置对象
     * @param userId 用户ID（用于转移所有权）
     * @returns 上传结果映射
     */
    async uploadReferencedDocuments(
        wikiLinks: WikiLinkInfo[], 
        onProgress?: (status: string) => void,
        applyPermissions: boolean = false,
        permissions?: {
            isPublic: boolean;
            allowCopy: boolean;
            allowCreateCopy: boolean;
            allowPrintDownload: boolean;
            copyEntity?: string;
            securityEntity?: string;
        },
        userId?: string
    ): Promise<Map<string, UploadResult>> {
        const results = new Map<string, UploadResult>();
        
        for (let i = 0; i < wikiLinks.length; i++) {
            const wikiLink = wikiLinks[i];
            if (!wikiLink) continue; // 跳过undefined项
            
            const progress = `正在处理引用文档 ${i + 1}/${wikiLinks.length}: ${wikiLink.title}`;
            onProgress?.(progress);
            
            try {
                const result = await this.uploadSingleDocument(wikiLink);
                if (result) {
                    results.set(wikiLink.title, result);
                    wikiLink.feishuUrl = result.url;
                    wikiLink.feishuToken = result.token;
                    
                    // 如果需要应用权限设置，则为引用文档设置与主文档相同的权限
                    if (applyPermissions && permissions && result.token) {
                        try {
                            onProgress?.(`正在为引用文档设置权限: ${wikiLink.title}`);
                            
                            // 使用与主文档完全相同的权限设置方法
                            await this.feishuClient.setDocumentPermissions(result.token, permissions, userId);
                            
                            // 更新历史记录中的权限设置
                            if (this.plugin.updateHistoryPermissions) {
                                const permissionsToSave = {
                                    isPublic: permissions.isPublic,
                                    allowCopy: permissions.allowCopy,
                                    allowCreateCopy: permissions.allowCreateCopy
                                };
                                await this.plugin.updateHistoryPermissions(result.token, permissionsToSave);
                            }
                        } catch (permissionError) {
                            this.logError(`[双链处理] 引用文档权限设置失败: ${wikiLink.title}`, permissionError, {
                                title: wikiLink.title
                            });
                            // 权限设置失败不影响文档上传结果，继续处理
                        }
                    }
                }
            } catch (error) {
                this.logError(`[双链处理] 文档上传失败: ${wikiLink.title}`, error, {
                    title: wikiLink.title
                });
                // 继续处理其他文档，不中断整个流程
            }
        }
        
        return results;
    }

    /**
     * 上传单个文档到飞书
     * @param wikiLink 双链信息
     * @returns 上传结果
     */
    private async uploadSingleDocument(wikiLink: WikiLinkInfo): Promise<UploadResult | null> {
        // 如果没有找到文件，尝试重新查找
        if (!wikiLink.file) {
            const foundFile = this.findFileByTitle(wikiLink.title);
            if (!foundFile) return null;
            wikiLink.file = foundFile;
        }

        // 检查是否已经上传过
        if (this.uploadedDocuments.has(wikiLink.title)) {
            return this.uploadedDocuments.get(wikiLink.title)!;
        }

        // 检查是否正在处理中（防止循环引用）
        if (this.processingDocuments.has(wikiLink.title)) {
            return null;
        }

        // 标记为正在处理
        this.processingDocuments.add(wikiLink.title);

        try {
            // 读取文件内容
            const content = await this.app.vault.read(wikiLink.file);
            
            // 直接使用飞书客户端上传文档，传递正确的folderToken
            const uploadResult = await this.feishuClient.uploadDocument(
                wikiLink.file.name,
                content,
                this.plugin.settings.folderToken
            );
            
            const result: UploadResult = {
                token: uploadResult.token,
                url: uploadResult.url,
                title: wikiLink.title
            };
            
            // 缓存结果
            this.uploadedDocuments.set(wikiLink.title, result);
            
            return result;
            
        } catch (error) {
            this.logError(`[双链处理] 文档上传失败: ${wikiLink.title}`, error, {
                title: wikiLink.title
            });
            return null;
        } finally {
            // 移除处理标记
            this.processingDocuments.delete(wikiLink.title);
        }
    }

    /**
     * 将双链替换为飞书文档链接
     * @param content 原始内容
     * @param wikiLinks 双链信息数组
     * @returns 替换后的内容
     */
    replaceWikiLinksWithFeishuLinks(content: string, wikiLinks: WikiLinkInfo[]): string {
        let processedContent = content;
        
        // 按位置倒序排列，避免替换时位置偏移
        const sortedWikiLinks = [...wikiLinks].sort((a, b) => b.position - a.position);
        
        for (const wikiLink of sortedWikiLinks) {
            if (wikiLink.feishuUrl) {
                // 替换为Markdown链接格式: [显示文本](飞书链接)
                const markdownLink = `[${wikiLink.title}](${wikiLink.feishuUrl})`;
                processedContent = processedContent.replace(wikiLink.originalText, markdownLink);
            }
        }
        
        return processedContent;
    }

    /**
     * 处理文档中的所有双链引用
     * @param content 文档内容
     * @param onProgress 进度回调
     * @param applyPermissions 是否应用权限设置（与主文档保持一致）
     * @param permissions 权限设置对象
     * @param userId 用户ID（用于转移所有权）
     * @returns 处理后的内容和上传结果
     */
    async processWikiLinks(
        content: string, 
        onProgress?: (status: string) => void,
        applyPermissions: boolean = false,
        permissions?: {
            isPublic: boolean;
            allowCopy: boolean;
            allowCreateCopy: boolean;
            allowPrintDownload: boolean;
            copyEntity?: string;
            securityEntity?: string;
        },
        userId?: string
    ): Promise<{ processedContent: string; uploadResults: Map<string, UploadResult> }> {
        // 提取双链引用
        const wikiLinks = this.extractWikiLinks(content);
        
        if (wikiLinks.length === 0) {
            return {
                processedContent: content,
                uploadResults: new Map()
            };
        }
        
        // 上传引用的文档，传递权限设置参数
        onProgress?.('正在上传引用的文档...');
        const uploadResults = await this.uploadReferencedDocuments(
            wikiLinks, 
            onProgress, 
            applyPermissions, 
            permissions, 
            userId
        );
        
        // 替换双链为飞书文档链接
        onProgress?.('正在替换双链为飞书链接...');
        const processedContent = this.replaceWikiLinksWithFeishuLinks(content, wikiLinks);
        
        return {
            processedContent,
            uploadResults
        };
    }

    /**
     * 清理缓存
     */
    clearCache(): void {
        this.uploadedDocuments.clear();
        this.processingDocuments.clear();
    }

    /**
     * 获取已上传文档的统计信息
     */
    getUploadStats(): { totalUploaded: number; uploadedTitles: string[] } {
        return {
            totalUploaded: this.uploadedDocuments.size,
            uploadedTitles: Array.from(this.uploadedDocuments.keys())
        };
    }
}
