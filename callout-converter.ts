/**
 * Callout 转换器 - 将 Obsidian Callout 转换为飞书高亮块
 * 支持 NOTE、WARNING、ERROR、TIP 等类型的 Callout
 */

import { FeishuApiClient } from './feishu-api';

export interface CalloutInfo {
    type: string;           // Callout 类型 (NOTE, WARNING, ERROR, TIP)
    content: string;        // Callout 内容
    originalText: string;   // 原始 Markdown 文本
    startIndex: number;     // 在原文中的起始位置
    endIndex: number;       // 在原文中的结束位置
}

export interface FeishuBlock {
    block_id?: string;
    block_type: number;
    parent_id?: string;
    index?: number;
    text?: {
        elements: Array<{
            text_run: {
                content: string;
            };
        }>;
    };
    quote?: {
        elements: Array<{
            text_run: {
                content: string;
            };
        }>;
        style?: {
            align: number;
            folded: boolean;
        };
    };
    callout?: {
        background_color: string;
        icon?: {
            emoji: string;
        };
        children: Array<{
            block_type: number;
            text: {
                elements: Array<{
                    text_run: {
                        content: string;
                    };
                }>;
            };
        }>;
    };
}



/**
 * Callout 转换器类
 */
export class CalloutConverter {
    private feishuClient: FeishuApiClient;

    constructor(feishuClient: FeishuApiClient) {
        this.feishuClient = feishuClient;
    }

    // Callout 类型映射表
    private static readonly CALLOUT_TYPE_MAPPING: Record<string, string> = {
        'NOTE': 'LightBlueBackground',
        'INFO': 'LightBlueBackground',
        'ABSTRACT': 'LightBlueBackground',
        'WARNING': 'LightOrangeBackground',
        'CAUTION': 'LightOrangeBackground',
        'ERROR': 'LightRedBackground',
        'DANGER': 'LightRedBackground',
        'TIP': 'LightGreenBackground',
        'HINT': 'LightGreenBackground',
        'SUCCESS': 'LightGreenBackground',
        'QUESTION': 'LightYellowBackground',
        'HELP': 'LightYellowBackground',
        'FAQ': 'LightYellowBackground'
    };

    // 飞书API需要的数字格式背景颜色映射
    private static readonly CALLOUT_COLOR_NUMBER_MAPPING: Record<string, number> = {
        'NOTE': 1,      // 蓝色
        'INFO': 1,      // 蓝色
        'ABSTRACT': 1,  // 蓝色
        'WARNING': 3,   // 橙色
        'CAUTION': 3,   // 橙色
        'ERROR': 2,     // 红色
        'DANGER': 2,    // 红色
        'TIP': 4,       // 绿色
        'HINT': 4,      // 绿色
        'SUCCESS': 4,   // 绿色
        'QUESTION': 5,  // 黄色
        'HELP': 5,      // 黄色
        'FAQ': 5        // 黄色
    };

    // Callout 正则表达式 - 匹配完整的 Callout 块
	private static readonly CALLOUT_REGEX = /^> \[!([A-Za-z]+)\][+-]?[^\n]*(?:\n((?:> .*\n?)*))?/gm;

    /**
     * 从 Markdown 文本中提取所有 Callout
     * @param markdown Markdown 文本
     * @returns Callout 信息数组
     */
    extractCallouts(markdown: string): CalloutInfo[] {
        const callouts: CalloutInfo[] = [];
        let match;

        // 调试：打印输入的markdown内容
        console.log('[Callout调试] 输入的markdown长度:', markdown.length);
        console.log('[Callout调试] 输入的markdown前500字符:', markdown.substring(0, 500));
        console.log('[Callout调试] 使用的正则表达式:', CalloutConverter.CALLOUT_REGEX);
        
        // 测试简化的正则表达式
        const testRegex = /^> \[!([A-Za-z]+)\]/gm;
        testRegex.lastIndex = 0;
        let testMatch;
        console.log('[Callout调试] 测试简化正则表达式匹配:');
        while ((testMatch = testRegex.exec(markdown)) !== null) {
            console.log('[Callout调试] 简化正则找到:', testMatch[0], '类型:', testMatch[1]);
        }
        
        // 测试新的正则表达式
        const newRegex = /^> \[!([A-Za-z]+)\][+-]?[^\n]*(?:\n((?:> .*\n?)*))?/gm;
        newRegex.lastIndex = 0;
        let newMatch;
        console.log('[Callout调试] 测试新正则表达式匹配:');
        while ((newMatch = newRegex.exec(markdown)) !== null) {
            console.log('[Callout调试] 新正则找到:', newMatch[0], '类型:', newMatch[1], '内容:', newMatch[2]);
        }
        
        // 字符级别调试
         const lines = markdown.split('\n');
         console.log('[Callout调试] 前10行内容:');
         for (let i = 0; i < Math.min(10, lines.length); i++) {
             const line = lines[i];
             if (line !== undefined) {
                 console.log(`[Callout调试] 第${i+1}行: "${line}" (长度: ${line.length})`);
                 if (line.startsWith('> [!')) {
                     console.log(`[Callout调试] 第${i+1}行字符码:`, Array.from(line).map(c => c.charCodeAt(0)));
                 }
             }
         }

        // 重置正则表达式的 lastIndex
        CalloutConverter.CALLOUT_REGEX.lastIndex = 0;

        while ((match = CalloutConverter.CALLOUT_REGEX.exec(markdown)) !== null) {
            console.log('[Callout调试] 找到匹配:', match);
            const [fullMatch, type, contentBlock] = match;
            if (!type) continue; // 跳过无效匹配
            
            const startIndex = match.index;
            const endIndex = startIndex + fullMatch.length;

            // 处理内容块，去掉每行的 '> ' 前缀
            const contentLines: string[] = [];
            
            if (contentBlock) {
                const lines = contentBlock.split('\n');
                for (const line of lines) {
                    if (line.startsWith('> ')) {
                        contentLines.push(line.substring(2));
                    } else if (line.trim()) {
                        contentLines.push(line);
                    }
                }
            }

            const processedContent = contentLines.join('\n').trim();

            callouts.push({
                type: type.toUpperCase(),
                content: processedContent || '无内容',
                originalText: fullMatch,
                startIndex,
                endIndex
            });
        }

        return callouts;
    }

    /**
     * 获取 Callout 类型对应的飞书背景色
     * @param type Callout 类型
     * @returns 飞书背景色
     */
    getBackgroundColor(type: string): string {
        return CalloutConverter.CALLOUT_TYPE_MAPPING[type.toUpperCase()] || 'LightGrayBackground';
    }

    /**
     * 获取飞书API需要的数字格式背景颜色
     * @param type Callout类型
     * @returns 数字格式的背景颜色
     */
    getBackgroundColorNumber(type: string): number {
        return CalloutConverter.CALLOUT_COLOR_NUMBER_MAPPING[type.toUpperCase()] || 1;
    }

    /**
     * 创建飞书高亮块结构
     * @param callout Callout 信息
     * @returns 飞书高亮块结构
     */
    createFeishuCalloutBlock(callout: CalloutInfo): FeishuBlock {
        const backgroundColor = this.getBackgroundColor(callout.type);
        const emoji = this.getEmojiForType(callout.type);
        
        return {
            block_type: 19, // 高亮块类型
            callout: {
                background_color: backgroundColor,
                icon: {
                    emoji: emoji
                },
                children: [
                    {
                        block_type: 2, // 文本块类型
                        text: {
                            elements: [
                                {
                                    text_run: {
                                        content: callout.content
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
     * 创建包含完整内容的飞书Callout块（用于从引用块转换）
     * @param type Callout类型
     * @param content 实际内容
     * @returns 飞书块对象
     */
    createFeishuCalloutBlockWithContent(type: string, content: string): FeishuBlock {
        const backgroundColor = this.getBackgroundColor(type);
        const emoji = this.getEmojiForType(type);
        
        return {
            block_type: 19, // 高亮块类型
            callout: {
                background_color: backgroundColor,
                icon: {
                    emoji: emoji
                },
                children: [
                    {
                        block_type: 2, // 文本块类型
                        text: {
                            elements: [
                                {
                                    text_run: {
                                        content: content
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
     * 创建嵌套的飞书Callout块结构（用于descendant API）
     * @param callout Callout信息
     * @returns 嵌套块结构
     */
    createFeishuCalloutDescendants(callout: CalloutInfo): {
        childrenIds: string[];
        descendants: any[];
    } {
        const backgroundColorNumber = this.getBackgroundColorNumber(callout.type);
        
        const calloutBlockId = `callout_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const textBlockId = `text_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        return {
            childrenIds: [calloutBlockId],
            descendants: [
                {
                    block_id: calloutBlockId,
                    block_type: 19,
                    callout: {
                        background_color: backgroundColorNumber,
                        border_color: 2,
                        text_color: 5
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
                                    content: callout.content
                                }
                            }
                        ]
                    }
                }
            ]
        };
    }

    /**
     * 根据callout类型获取emoji
     * @param type Callout类型
     * @returns emoji字符串
     */
    private getEmojiForType(type: string): string {
        const emojiMap: Record<string, string> = {
            'note': '📝',
            'info': 'ℹ️',
            'abstract': '📄',
            'tip': '💡',
            'hint': '💡',
            'success': '✅',
            'warning': '⚠️',
            'caution': '⚠️',
            'error': '❌',
            'danger': '⚠️',
            'question': '❓',
            'help': '❓',
            'faq': '❓'
        };
        
        return emojiMap[type.toLowerCase()] || '📌';
    }

    /**
     * 在飞书文档块中查找对应的引用块
     * @param blocks 飞书文档块数组
     * @param callouts 提取的 Callout 信息
     * @returns 匹配的块信息
     */
    findMatchingQuoteBlocks(
        blocks: FeishuBlock[], 
        callouts: CalloutInfo[]
    ): Array<{ callout: CalloutInfo; block: FeishuBlock }> {
        const matches: Array<{ callout: CalloutInfo; block: FeishuBlock }> = [];

        for (const callout of callouts) {
            // 查找类型为引用块(15)且内容匹配的块
            const matchingBlock = blocks.find(block => {
                if (block.block_type !== 15) return false; // 不是引用块
                
                // 检查引用块内容是否匹配
                if (block.quote && block.quote.elements) {
                    const blockContent = block.quote.elements
                        .map(element => element.text_run?.content || '')
                        .join('')
                        .trim();
                    
                    console.log('[Callout调试] 检查引用块内容:', blockContent);
                    console.log('[Callout调试] Callout原始文本:', callout.originalText);
                    
                    // 检查是否包含Callout标记
                    const calloutPattern = `[!${callout.type.toLowerCase()}]`;
                    const hasCalloutMarker = blockContent.includes(calloutPattern) || 
                                           blockContent.includes(`[!${callout.type.toUpperCase()}]`);
                    
                    console.log('[Callout调试] 查找模式:', calloutPattern, '是否匹配:', hasCalloutMarker);
                    
                    return hasCalloutMarker;
                }
                
                return false;
            });

            if (matchingBlock) {
                console.log('[Callout调试] 找到匹配的引用块:', matchingBlock.block_id);
                matches.push({ callout, block: matchingBlock });
            } else {
                console.log('[Callout调试] 未找到匹配的引用块，Callout类型:', callout.type);
            }
        }

        return matches;
    }

    /**
     * 处理单个 Callout 转换（插入新块并删除原块）
     * @param documentId 文档ID
     * @param callout Callout信息
     * @param block 原引用块
     * @returns 转换结果
     */
    async processSingleCalloutConversion(
        documentId: string,
        callout: CalloutInfo,
        block: FeishuBlock
    ): Promise<boolean> {
        try {
            console.log('[Callout转换] 开始处理单个Callout转换:', {
                documentId,
                calloutType: callout.type,
                blockId: block.block_id,
                parentId: block.parent_id,
                index: block.index
            });

            // 检查必要的信息：index和parent_id都必须存在
            if (block.index !== undefined && block.parent_id) {
                // 直接使用从飞书API获取的parent_id，不要替换为documentId
                const actualParentId = block.parent_id;
                
                console.log('[Callout转换] 父块ID确定:', {
                    parentId: block.parent_id,
                    actualParentId: actualParentId,
                    documentId: documentId
                });
                // 从原引用块中提取完整内容
                const blockContent = block.quote?.elements
                    ?.map(element => element.text_run?.content || '')
                    .join('')
                    .trim() || '';
                
                console.log('[Callout转换] 提取的原块内容:', blockContent);
                
                // 提取callout信息（去掉[!type]标记后的内容）
                const match = blockContent.match(/\[!(\w+)\]([+-]?)\s*(.*)$/s);
                const actualContent = match && match[3] ? match[3].trim() : blockContent;
                
                console.log('[Callout转换] 处理后的内容:', actualContent);
                
                // 创建嵌套的callout块结构
                const calloutInfo = { ...callout, content: actualContent };
                const { childrenIds, descendants } = this.createFeishuCalloutDescendants(calloutInfo);
                
                console.log('[Callout转换] 创建的嵌套Callout块结构:', {
                    childrenIds,
                    descendants: JSON.stringify(descendants, null, 2)
                });
                
                // 第一步：先删除原来的引用块
                if (block.block_id) {
                    console.log('[Callout转换] 步骤1 - 开始删除原引用块:', {
                        documentId,
                        blockId: block.block_id,
                        parentId: actualParentId,
                        index: block.index
                    });

                    await this.feishuClient.deleteDocumentBlock(
                        documentId,
                        block.block_id,
                        actualParentId,
                        block.index
                    );

                    console.log('[Callout转换] 步骤1 - 删除原引用块成功');
                    
                    // 等待500ms确保删除操作完全完成，避免位置冲突
                    await new Promise(resolve => setTimeout(resolve, 500));
                } else {
                    console.warn('[Callout转换] 警告：原块没有block_id，跳过删除步骤');
                }
                
                // 第二步：使用descendant API插入新的嵌套高亮块
                console.log('[Callout转换] 步骤2 - 开始插入嵌套Callout块:', {
                    documentId,
                    parentId: actualParentId,
                    index: block.index,
                    childrenIds,
                    descendantsCount: descendants.length
                });

                // 执行嵌套块插入操作
                await this.feishuClient.createDocumentDescendants(
                    documentId,
                    actualParentId,
                    block.index,
                    childrenIds,
                    descendants
                );

                console.log('[Callout转换] 步骤2 - 插入新Callout块成功');
                console.log('[Callout转换] 单个Callout转换完成');

                return true;
            } else {
                console.error('[Callout转换] 错误：缺少必要信息', {
                    parentId: block.parent_id,
                    index: block.index,
                    hasParentId: !!block.parent_id,
                    hasIndex: block.index !== undefined
                });
                return false;
            }
        } catch (error) {
            console.error('[Callout转换] 单个转换失败:', {
                documentId,
                calloutType: callout.type,
                blockId: block.block_id,
                error: error instanceof Error ? error.message : String(error)
            });
            return false;
        }
    }



    /**
     * 为文档块添加索引信息
     * @param blocks 原始文档块数组
     * @returns 添加索引后的块数组
     */
    addIndexToBlocks(blocks: any[]): FeishuBlock[] {
        const blocksWithIndex: FeishuBlock[] = [];
        const parentChildrenMap = new Map<string, any[]>();
        
        // 1. 构建父子关系映射
        for (const block of blocks) {
            if (block.parent_id) {
                if (!parentChildrenMap.has(block.parent_id)) {
                    parentChildrenMap.set(block.parent_id, []);
                }
                parentChildrenMap.get(block.parent_id)!.push(block);
            }
        }
        
        // 2. 为每个块分配索引
        for (const block of blocks) {
            const feishuBlock: FeishuBlock = {
                block_id: block.block_id,
                block_type: block.block_type,
                parent_id: block.parent_id,
                text: block.text,
                quote: block.quote,
                callout: block.callout
            };
            
            // 如果有父块，计算在父块中的索引
            if (block.parent_id && parentChildrenMap.has(block.parent_id)) {
                const siblings = parentChildrenMap.get(block.parent_id)!;
                const index = siblings.findIndex(sibling => sibling.block_id === block.block_id);
                feishuBlock.index = index >= 0 ? index : 0;
            } else {
                // 顶级块，索引为在所有顶级块中的位置
                const topLevelBlocks = blocks.filter(b => !b.parent_id);
                const index = topLevelBlocks.findIndex(b => b.block_id === block.block_id);
                feishuBlock.index = index >= 0 ? index : 0;
            }
            
            blocksWithIndex.push(feishuBlock);
        }
        
        console.log('[Callout转换] 索引分配完成:', {
            totalBlocks: blocksWithIndex.length,
            parentChildrenMap: Array.from(parentChildrenMap.entries()).map(([parentId, children]) => ({
                parentId,
                childrenCount: children.length
            }))
        });
        
        return blocksWithIndex;
    }

    /**
     * 验证 Callout 类型是否支持
     * @param type Callout 类型
     * @returns 是否支持
     */
    isSupportedCalloutType(type: string): boolean {
        return type.toUpperCase() in CalloutConverter.CALLOUT_TYPE_MAPPING;
    }

    /**
     * 获取所有支持的 Callout 类型
     * @returns 支持的类型数组
     */
    getSupportedCalloutTypes(): string[] {
        return Object.keys(CalloutConverter.CALLOUT_TYPE_MAPPING);
    }

    /**
     * 预览 Callout 转换结果（不执行实际转换）
     * @param markdown Markdown 文本
     * @returns 转换预览信息
     */
    previewConversion(markdown: string): {
        callouts: CalloutInfo[];
        supportedCount: number;
        unsupportedTypes: string[];
    } {
        const callouts = this.extractCallouts(markdown);
        const supportedCount = callouts.filter(c => this.isSupportedCalloutType(c.type)).length;
        const unsupportedTypes = [...new Set(
            callouts
                .filter(c => !this.isSupportedCalloutType(c.type))
                .map(c => c.type)
        )];

        return {
            callouts,
            supportedCount,
            unsupportedTypes
        };
    }

    /**
     * 转换文档中的 Callout 为飞书高亮块
     * @param documentId 飞书文档ID
     * @param markdown Markdown 内容
     * @param selectedCalloutIndices 选中的 Callout 索引数组
     * @returns 转换结果
     */
    async convertCalloutsInDocument(
        documentId: string,
        markdown: string,
        selectedCalloutIndices: number[]
    ): Promise<{
        success: boolean;
        convertedCount: number;
        error?: string;
    }> {
        try {
            // 1. 提取所有 Callout
            const allCallouts = this.extractCallouts(markdown);
            if (allCallouts.length === 0) {
                return {
                    success: false,
                    convertedCount: 0,
                    error: '未找到任何 Callout'
                };
            }

            // 2. 筛选用户选择的 Callout
            const selectedCallouts = allCallouts.filter((_, index) => 
                selectedCalloutIndices.includes(index)
            );

            if (selectedCallouts.length === 0) {
                return {
                    success: false,
                    convertedCount: 0,
                    error: '未选择任何 Callout'
                };
            }

            // 3. 转换 Markdown 为飞书块结构
            const conversionResult = await this.feishuClient.convertMarkdownToBlocks(markdown);
            if (!conversionResult?.blocks) {
                return {
                    success: false,
                    convertedCount: 0,
                    error: 'Markdown 转换失败'
                };
            }

            // 4. 获取文档所有块的详细信息
            const documentBlocks = await this.feishuClient.getDocumentBlocksDetailed(documentId);
            
            console.log('[Callout转换] 从飞书API获取的原始块数据:', documentBlocks.map(b => ({
                block_id: b.block_id,
                block_type: b.block_type,
                parent_id: b.parent_id,
                hasParentId: !!b.parent_id
            })));
            
            // 4.1. 为每个块添加索引信息（根据父子关系计算索引）
            const blocksWithIndex = this.addIndexToBlocks(documentBlocks);
            
            console.log('[Callout转换] 添加索引后的块信息:', blocksWithIndex.map(b => ({
                block_id: b.block_id,
                block_type: b.block_type,
                parent_id: b.parent_id,
                index: b.index
            })));

            // 5. 查找匹配的引用块
            const matches = this.findMatchingQuoteBlocks(blocksWithIndex, selectedCallouts);
            if (matches.length === 0) {
                return {
                    success: false,
                    convertedCount: 0,
                    error: '未找到匹配的引用块，请确保文档已同步'
                };
            }

            // 6. 逐个处理 Callout 转换（严格按顺序执行，确保位置参数正确）
            let convertedCount = 0;
            for (const { callout, block } of matches) {
                console.log(`[Callout转换] 开始处理第 ${convertedCount + 1}/${matches.length} 个转换`);
                
                const success = await this.processSingleCalloutConversion(
                    documentId,
                    callout,
                    block
                );
                
                if (success) {
                    convertedCount++;
                    console.log(`[Callout转换] 第 ${convertedCount} 个转换成功完成`);
                    
                    // 在每个转换之间添加额外延迟，确保飞书服务器状态同步
                    if (convertedCount < matches.length) {
                        console.log('[Callout转换] 等待服务器状态同步...');
                        await new Promise(resolve => setTimeout(resolve, 800));
                    }
                } else {
                    console.error(`[Callout转换] 第 ${convertedCount + 1} 个转换失败`);
                }
            }

            if (convertedCount === 0) {
                return {
                    success: false,
                    convertedCount: 0,
                    error: '所有 Callout 转换都失败了'
                };
            }

            return {
                 success: true,
                 convertedCount: convertedCount
             };

        } catch (error) {
            console.error('[CalloutConverter] 转换失败:', error);
            return {
                success: false,
                convertedCount: 0,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
}