/**
 * YAML 处理器 - 将 Obsidian YAML frontmatter 转换为飞书高亮块
 * 支持标准的 YAML 格式解析和美化显示
 */

import { FeishuApiClient } from './feishu-api';

export interface YamlInfo {
    // 动态字段支持 - 可以包含任何YAML字段
    [key: string]: any;
    
    // 必需的元数据字段
    originalText: string;   // 原始 YAML 文本
    startIndex: number;     // 在原文中的起始位置
    endIndex: number;       // 在原文中的结束位置
}

export interface FeishuYamlBlock {
    block_id?: string;
    block_type: number;
    parent_id?: string;
    index?: number;
    callout?: {
        background_color: string | number;
        icon?: {
            emoji: string;
        };
        children: Array<{
            block_type: number;
            text: {
                elements: Array<{
                    text_run: {
                        content: string;
                        text_element_style?: {
                            bold?: boolean;
                            italic?: boolean;
                            strikethrough?: boolean;
                            underline?: boolean;
                            inline_code?: boolean;
                            text_color?: number;
                            background_color?: number;
                        };
                    };
                }>;
            };
        }>;
    };
}

/**
 * YAML 处理器类
 */
export class YamlProcessor {
    private feishuClient: FeishuApiClient;
    private static debugEnabled = false;

    static setDebugEnabled(enabled: boolean): void {
        this.debugEnabled = enabled;
    }

    private debug(...args: any[]): void {
        if (YamlProcessor.debugEnabled) {
            console.debug(...args);
        }
    }

    private logError(summary: string, error: unknown, details?: any): void {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(summary, errorMessage);
        this.debug(`${summary} 详情:`, {
            ...details,
            error,
            errorMessage,
            errorStack: error instanceof Error ? error.stack : undefined
        });
    }

    constructor(feishuClient: FeishuApiClient) {
        this.feishuClient = feishuClient;
    }

    // YAML frontmatter 正则表达式
    private static readonly YAML_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n/;

    /**
     * 从 Markdown 文本中提取 YAML frontmatter
     * @param markdown Markdown 文本
     * @returns YAML 信息数组
     */
    extractYaml(markdown: string): YamlInfo | null {
        const match = YamlProcessor.YAML_REGEX.exec(markdown);
        
        if (!match) {
            return null;
        }

        const yamlContent = match[1];
        const originalText = match[0];
        const startIndex = match.index || 0;
        const endIndex = (match.index || 0) + originalText.length;

        try {
            if (!yamlContent) {
                return null;
            }
            const yamlInfo = this.parseYamlContent(yamlContent);
            return {
                ...yamlInfo,
                originalText,
                startIndex,
                endIndex
            } as YamlInfo;
        } catch (error) {
            this.logError('[YAML处理器] YAML 解析错误:', error);
            return null;
        }
    }

    /**
     * 解析 YAML 内容
     * @param yamlContent YAML 字符串内容
     * @returns 解析后的 YAML 对象
     */
    private parseYamlContent(yamlContent: string): Partial<YamlInfo> {
        const result: Partial<YamlInfo> = {};
        const lines = yamlContent.split('\n');
        
        let currentKey = '';
        let isInArray = false;
        let arrayItems: string[] = [];

        for (const line of lines) {
            const trimmedLine = line.trim();
            
            if (!trimmedLine || trimmedLine.startsWith('#')) {
                continue; // 跳过空行和注释
            }

            // 处理数组项
            if (trimmedLine.startsWith('- ')) {
                if (isInArray && currentKey) {
                    arrayItems.push(trimmedLine.substring(2).trim());
                }
                continue;
            }

            // 如果之前在处理数组，现在结束了
            if (isInArray && !trimmedLine.startsWith('- ')) {
                if (currentKey) {
                    result[currentKey] = arrayItems;
                }
                isInArray = false;
                arrayItems = [];
            }

            // 处理键值对
            const colonIndex = trimmedLine.indexOf(':');
            if (colonIndex > 0) {
                const key = trimmedLine.substring(0, colonIndex).trim();
                const value = trimmedLine.substring(colonIndex + 1).trim();
                
                currentKey = key;

                if (value === '') {
                    // 可能是数组的开始
                    isInArray = true;
                    arrayItems = [];
                } else {
                    // 直接的键值对 - 自动类型推断
                    result[key] = this.parseYamlValue(value);
                }
            }
        }

        // 处理最后的数组
        if (isInArray && currentKey) {
            result[currentKey] = arrayItems;
        }

        return result;
    }

    /**
     * 解析YAML值，自动推断类型
     * @param value 原始字符串值
     * @returns 解析后的值
     */
    private parseYamlValue(value: string): any {
        // 移除引号
        const trimmedValue = value.replace(/^["']|["']$/g, '');
        
        // 布尔值
        if (trimmedValue.toLowerCase() === 'true') return true;
        if (trimmedValue.toLowerCase() === 'false') return false;
        
        // null/undefined
        if (trimmedValue.toLowerCase() === 'null' || trimmedValue === '~') return null;
        
        // 数字
        if (/^-?\d+$/.test(trimmedValue)) {
            return parseInt(trimmedValue, 10);
        }
        if (/^-?\d*\.\d+$/.test(trimmedValue)) {
            return parseFloat(trimmedValue);
        }
        
        // 数组（单行，逗号分隔）
        if (trimmedValue.includes(',')) {
            return trimmedValue.split(',').map(item => item.trim());
        }
        
        // 默认返回字符串
        return trimmedValue;
    }

    /**
     * 创建飞书 YAML 高亮块
     * @param yamlInfo YAML 信息
     * @returns 飞书高亮块对象
     */
    createFeishuYamlBlock(yamlInfo: YamlInfo): FeishuYamlBlock {
        const content = this.formatYamlContent(yamlInfo);
        
        return {
            block_type: 19, // 高亮块类型
            callout: {
                background_color: 'LightGrayBackground', // 使用灰色背景
                icon: {
                    emoji: '📄' // 使用页面图标
                },
                children: [
                    {
                        block_type: 2, // 文本块类型
                        text: {
                            elements: [
                                {
                                    text_run: {
                                        content: content
                                        // 移除代码样式
                                    }
                                }
                            ]
                        }
                    }
                ]
            }
        };
    }

    /**
     * 创建数字格式的飞书 YAML 高亮块（用于 descendant API）
     * @param yamlInfo YAML 信息
     * @returns 嵌套块结构
     */
    createFeishuYamlDescendants(yamlInfo: YamlInfo): {
        childrenIds: string[];
        descendants: any[];
    } {
        const content = this.formatYamlContent(yamlInfo);
        
        const calloutBlockId = `yaml_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const textBlockId = `text_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        return {
            childrenIds: [calloutBlockId],
            descendants: [
                {
                    block_id: calloutBlockId,
                    block_type: 19,
                    callout: {
                        background_color: 6, // 灰色背景（数字格式）
                        border_color: 2,
                        text_color: 5,
                        emoji_id : 'page_facing_up'
                    },
                    children: [textBlockId]
                },
                {
                    block_id: textBlockId,
                    block_type: 2,
                    children: [],
                    text: {
                        elements: [
                            {
                                text_run: {
                                    content: content
                                    // 移除代码样式
                                }
                            }
                        ]
                    }
                }
            ]
        };
    }

    /**
     * 格式化 YAML 内容为可读的字符串
     * @param yamlInfo YAML 信息
     * @returns 格式化后的字符串
     */
    private formatYamlContent(yamlInfo: YamlInfo): string {
        const lines: string[] = ['📄 文档信息'];
        
        // 定义字段显示的优先级和图标映射
        const fieldConfig: { [key: string]: { icon: string; label: string; priority: number } } = {
            title: { icon: '📝', label: '标题', priority: 1 },
            date: { icon: '📅', label: '日期', priority: 2 },
            category: { icon: '📂', label: '类别', priority: 3 },
            tags: { icon: '🏷️', label: '标签', priority: 4 },
            alias: { icon: '🔗', label: '别名', priority: 5 },
            stars: { icon: '⭐', label: '评级', priority: 6 },
            from: { icon: '📖', label: '来源', priority: 7 },
            url: { icon: '🔗', label: '链接', priority: 8 },
            author: { icon: '👤', label: '作者', priority: 9 },
            status: { icon: '📊', label: '状态', priority: 10 },
            priority: { icon: '🔥', label: '优先级', priority: 11 },
            created: { icon: '🆕', label: '创建时间', priority: 12 },
            updated: { icon: '🔄', label: '更新时间', priority: 13 },
            version: { icon: '🔢', label: '版本', priority: 14 },
            description: { icon: '📄', label: '描述', priority: 15 }
        };

        // 获取所有字段并按优先级排序
        const allFields = Object.keys(yamlInfo)
            .filter(key => !['originalText', 'startIndex', 'endIndex'].includes(key))
            .sort((a, b) => {
                const priorityA = fieldConfig[a]?.priority || 999;
                const priorityB = fieldConfig[b]?.priority || 999;
                return priorityA - priorityB;
            });

        // 格式化每个字段
        for (const key of allFields) {
            const value = yamlInfo[key];
            if (value === undefined || value === null) continue;

            const config = fieldConfig[key] || { icon: '📌', label: key, priority: 999 };
            const formattedValue = this.formatFieldValue(key, value);
            
            if (formattedValue) {
                lines.push(`${config.icon} ${config.label}: ${formattedValue}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * 格式化字段值用于显示
     * @param key 字段名
     * @param value 字段值
     * @returns 格式化后的字符串
     */
    private formatFieldValue(key: string, value: any): string {
        if (value === undefined || value === null) return '';

        // 特殊字段的格式化
        switch (key) {
            case 'stars':
                if (typeof value === 'number' && value >= 0 && value <= 5) {
                    const starString = '⭐'.repeat(Math.floor(value));
                    return `${starString} (${value}/5)`;
                }
                return String(value);
                
            case 'tags':
                if (Array.isArray(value)) {
                    return value.join(', ');
                }
                return String(value);
                
            case 'date':
            case 'created':
            case 'updated':
                // 尝试格式化日期
                if (typeof value === 'string') {
                    const date = new Date(value);
                    if (!isNaN(date.getTime())) {
                        return date.toLocaleDateString('zh-CN');
                    }
                }
                return String(value);
                
            default:
                if (Array.isArray(value)) {
                    return value.join(', ');
                } else if (typeof value === 'object') {
                    return JSON.stringify(value);
                } else {
                    return String(value);
                }
        }
    }

    /**
     * 检查文档是否包含 YAML frontmatter
     * @param markdown Markdown 文本
     * @returns 是否包含 YAML
     */
    hasYamlFrontmatter(markdown: string): boolean {
        return YamlProcessor.YAML_REGEX.test(markdown);
    }

    /**
     * 移除 Markdown 文本中的 YAML frontmatter
     * @param markdown Markdown 文本
     * @returns 移除 YAML 后的文本
     */
    removeYamlFrontmatter(markdown: string): string {
        return markdown.replace(YamlProcessor.YAML_REGEX, '');
    }

    /**
     * 预览 YAML 转换结果
     * @param markdown Markdown 文本
     * @returns 预览信息
     */
    previewYamlConversion(markdown: string): {
        hasYaml: boolean;
        yamlInfo: YamlInfo | null;
        formattedContent: string | null;
    } {
        const yamlInfo = this.extractYaml(markdown);
        
        return {
            hasYaml: yamlInfo !== null,
            yamlInfo,
            formattedContent: yamlInfo ? this.formatYamlContent(yamlInfo) : null
        };
    }

    /**
     * 在文档中插入YAML信息块
     * @param documentId 文档ID
     * @param yamlInfo YAML信息
     * @param insertIndex 插入位置索引
     */
    async insertYamlBlockInDocument(
        documentId: string,
        yamlInfo: YamlInfo,
        insertIndex: number = 0
    ): Promise<boolean> {
        try {

            // 获取文档的所有块来找到根块ID
            const documentBlocks = await this.feishuClient.getDocumentBlocksDetailed(documentId);
            if (!documentBlocks || documentBlocks.length === 0) {
                console.error('[YAML处理器] 无法获取文档块信息');
                return false;
            }
            
            // 找到根块（通常是第一个块或者没有parent_id的块）
            const rootBlock = documentBlocks.find(block => !block.parent_id) || documentBlocks[0];
            if (!rootBlock) {
                console.error('[YAML处理器] 无法找到文档根块');
                return false;
            }
            
            // 创建嵌套的YAML块结构
            const descendants = this.createFeishuYamlDescendants(yamlInfo);
            
            // 使用嵌套块API插入YAML信息块
            const response = await this.feishuClient.createDocumentDescendants(
                documentId,
                rootBlock.block_id,
                insertIndex,
                descendants.childrenIds,
                descendants.descendants
            );
            
            return response && response.code === 0;
        } catch (error) {
            this.logError('[YAML处理器] 插入YAML块失败:', error, { documentId, insertIndex });
            return false;
        }
    }
}
