import { FeishuApiClient } from './feishu-api';
import { YamlProcessor } from './yaml-processor';
import { requestUrl } from 'obsidian';

/**
 * 智能更新结果接口
 */
export interface SmartUpdateResult {
    success: boolean;
    documentId: string;
    url: string;
    error?: string;
}

/**
 * 智能更新模块
 * 负责检测重复文档并进行智能更新，而不是创建新文档
 */
export class SmartUpdateManager {
    private feishuClient: FeishuApiClient;
    private static debugEnabled = false;

    static setDebugEnabled(enabled: boolean): void {
        this.debugEnabled = enabled;
    }

    private debug(...args: any[]): void {
        if (SmartUpdateManager.debugEnabled) {
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

    /**
     * 检查是否存在同名文档
     * @param title 文档标题
     * @param uploadHistory 上传历史记录
     * @returns 如果存在返回文档信息，否则返回null
     */
    findExistingDocument(title: string, uploadHistory: any[]): { docToken: string; url: string } | null {
        // 查找同名文档（排除引用文档）
        const existingDoc = uploadHistory.find(item => 
            item.title === title && !item.isReferencedDocument
        );
        
        if (existingDoc) {
            return {
                docToken: existingDoc.docToken,
                url: existingDoc.url
            };
        }
        
        return null;
    }

    /**
     * 获取文档根块ID
     * @param documentId 文档ID
     * @returns 根块ID
     */
    async getDocumentRootBlockId(documentId: string): Promise<string> {
        try {
            this.debug('[智能更新] 根据飞书官方文档，页面块的block_id与document_id相同:', documentId);
            
            // 根据飞书官方文档：每一篇文档都有一个根块，即页面块（Page block）。
            // 页面块的 block_id 与其所在文档的 document_id 相同。
            // 参考：https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/docx-overview
            return documentId;
            
        } catch (error) {
            this.logError('[智能更新] 获取根块ID失败:', error);
            throw new Error(`获取文档根块ID失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 删除根块下的所有子块
     * @param documentId 文档ID
     * @param rootBlockId 根块ID
     */
    async deleteAllChildBlocks(documentId: string, rootBlockId: string): Promise<void> {
        try {
            this.debug('正在删除所有子块...');
            
            // 获取根块的所有子块
            const blocks = await this.feishuClient.getDocumentBlocksDetailed(documentId);
            
            // 找到根块的直接子块
            const childBlocks = blocks.filter(block => block.parent_id === rootBlockId);
            
            if (childBlocks.length === 0) {
                this.debug('没有找到子块，跳过删除步骤');
                return;
            }
            
            this.debug(`找到 ${childBlocks.length} 个子块，开始批量删除`);
            
            // 使用索引范围批量删除：从第0个子块删除到最后一个子块
            // 左闭右开区间 [start_index, end_index)
            // start_index: 0 (第一个子块，包含)
            // end_index: childBlocks.length (不包含，所以正好删除所有子块)
            await this.feishuClient.batchDeleteDocumentBlocks(
                documentId,
                rootBlockId,
                0,  // start_index (包含)
                childBlocks.length  // end_index (不包含)
            );
            
            this.debug('所有子块批量删除完成');
            
        } catch (error) {
            this.logError('[智能更新] 删除子块失败:', error, { documentId, rootBlockId });
            throw new Error(`删除文档子块失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 重新导入内容到文档
     * @param documentId 文档ID
     * @param rootBlockId 根块ID
     * @param markdownContent Markdown内容
     */
    async reimportContent(documentId: string, rootBlockId: string, markdownContent: string, orderedImageInfos?: any[], yamlInfo?: any): Promise<void> {
        try {
            this.debug('[智能更新] 开始更新文档内容...');
            
            // 步骤1: 简化验证 - 仅检查文档基本可访问性
            this.debug('[智能更新] 验证文档访问权限...');
            const documentValidation = await this.validateDocumentAccess(documentId);
            if (!documentValidation.isValid) {
                throw new Error(`文档访问失败: ${documentValidation.errors.join(', ')}`);
            }
            
            // 智能更新模式：直接进行内容更新，无需权限测试
            this.debug('[智能更新] 文档验证通过，开始更新内容...');
            
            // 步骤3: 预处理Markdown内容（与常规上传流程保持一致）
            this.debug('[智能更新] 正在预处理Markdown内容...');
            
            // 首先转换Obsidian图片语法
            const convertedContent = FeishuApiClient.convertObsidianImageSyntax(markdownContent);
            
            // 然后处理连续文本行，确保它们保持独立（避免被飞书API合并）
            const processedContent = this.preprocessMarkdownForBlockSeparation(convertedContent);
            
            this.debug('[智能更新] Markdown预处理完成');
            
            // 步骤4: 收集图片信息（如果没有预处理的图片信息）
            let imageInfos: any[] = [];
            if (orderedImageInfos && orderedImageInfos.length > 0) {
                imageInfos = orderedImageInfos;
                this.debug(`[智能更新] 使用预处理的图片信息，共 ${imageInfos.length} 张图片`);
            } else {
                imageInfos = FeishuApiClient.extractImageInfoFromMarkdown(markdownContent, (this.feishuClient as any).app?.vault?.adapter?.basePath);
                this.debug(`[智能更新] 从Markdown提取图片信息，共 ${imageInfos.length} 张图片`);
            }
            
            // 步骤5: 将预处理后的Markdown转换为文档块结构
            const conversionResult = await this.feishuClient.convertMarkdownToBlocks(processedContent);
            
            if (!conversionResult?.blocks || conversionResult.blocks.length === 0) {
                throw new Error('Markdown转换失败或没有生成块');
            }
            
            this.debug(`[智能更新] Markdown转换成功，生成 ${conversionResult.blocks.length} 个块`);
            
            // 添加块顺序调试日志
            this.debug('[智能更新] 转换API返回的原始块顺序:');
            conversionResult.blocks.forEach((block: any, index: number) => {
                this.debug(`  [${index}] 类型: ${block.block_type}, 内容预览: ${this.getBlockContentPreview(block)}`);
            });
            
            // 步骤6: 验证和修正块顺序（根据官方建议）
            const orderedBlocks = this.validateAndFixBlockOrder(conversionResult.blocks, processedContent);
            
            // 步骤7: 验证和修正parent_id和children关系
            const relationFixedBlocks = this.validateAndFixParentChildRelations(orderedBlocks);
            
            // 步骤8: 过滤不支持的块类型并处理其他字段（根据飞书文档要求）
            const processedBlocks = this.processBlocksForInsertion(relationFixedBlocks);
            
            // 步骤7: 验证块层级结构
            let hierarchyErrors: string[] = [];
            for (const block of processedBlocks) {
                const validation = this.validateBlockHierarchy(block);
                hierarchyErrors.push(...validation.errors);
            }
            
            if (hierarchyErrors.length > 0) {
                console.warn('[智能更新] 块层级验证出现问题:', hierarchyErrors);
                // 不抛出错误，只记录警告，因为某些层级问题可能不会导致API失败
            }
            
            // 步骤8: 分离表格块和非表格块
            const { tableBlocks, nonTableBlocks } = this.separateTableBlocks(processedBlocks);
            
            // 步骤9: 先创建非表格块（根据飞书API限制，单次最多创建50个块）
            if (nonTableBlocks.length > 0) {
                this.debug(`[智能更新] 开始创建 ${nonTableBlocks.length} 个非表格块...`);
                await this.createBlocksInBatches(documentId, rootBlockId, nonTableBlocks);
                this.debug('[智能更新] 非表格块创建完成');
            }
            
            // 步骤10: 单独处理表格块（类似图片处理）
            if (tableBlocks.length > 0) {
                this.debug(`[智能更新] 开始单独处理 ${tableBlocks.length} 个表格块...`);
                await this.processTablesInDocument(documentId, rootBlockId, tableBlocks, nonTableBlocks.length);
                this.debug('[智能更新] 表格处理完成');
            }
            
            // 步骤11: 处理图片（如果有图片需要处理）
            if (imageInfos.length > 0) {
                this.debug(`[智能更新] 开始处理 ${imageInfos.length} 张图片...`);
                await this.feishuClient.processImagesInDocument(documentId, imageInfos, (status: string) => {
                    this.debug(`[智能更新] 图片处理: ${status}`);
                });
                this.debug('[智能更新] 图片处理完成');
            }
            
            // 步骤10: 处理Callout转换（与原有上传流程保持一致）
            this.debug('[智能更新] 开始处理Callout转换...');
            await this.processCalloutConversion(documentId);
            this.debug('[智能更新] Callout转换完成');
            
            // 步骤11: 处理YAML frontmatter（与原有上传流程保持一致）
            if (yamlInfo) {
                this.debug('[智能更新] 开始处理文档信息块...');
                await this.processYamlInsertion(documentId, yamlInfo);
                this.debug('[智能更新] 文档信息块处理完成');
            }
            
            this.debug('[智能更新] 内容重新导入完成');
            
        } catch (error) {
            this.logError('[智能更新] 重新导入内容失败:', error, { documentId, rootBlockId });
            throw new Error(`重新导入内容失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 分批创建块
     * @param documentId 文档ID
     * @param rootBlockId 根块ID
     * @param blocks 要创建的块数组
     */
    private async createBlocksInBatches(documentId: string, rootBlockId: string, blocks: any[]): Promise<void> {
        const BATCH_SIZE = 50; // 每批最多50个块，保守设置避免API限制
        const totalBlocks = blocks.length;
        let currentIndex = 0;
        
        this.debug(`[智能更新] 开始分批创建 ${totalBlocks} 个块，每批 ${BATCH_SIZE} 个`);
        
        // 添加整体块顺序调试日志
        this.debug('[智能更新] 即将插入的块顺序:');
        blocks.forEach((block: any, index: number) => {
            this.debug(`  [${index}] 类型: ${block.block_type}, 内容: ${this.getBlockContentPreview(block)}`);
        });
        
        // 分离表格块和非表格块
        const { tableBlocks, nonTableBlocks } = this.separateTableBlocks(blocks);
        
        // 先处理非表格块
        if (nonTableBlocks.length > 0) {
            this.debug(`[智能更新] 先创建 ${nonTableBlocks.length} 个非表格块`);
            await this.createNonTableBlocksInBatches(documentId, rootBlockId, nonTableBlocks, currentIndex);
            currentIndex += nonTableBlocks.length;
        }
        
        // 再分步处理表格块
        if (tableBlocks.length > 0) {
            this.debug(`[智能更新] 开始分步创建 ${tableBlocks.length} 个表格块`);
            await this.createTableBlocksStepByStep(documentId, rootBlockId, tableBlocks, currentIndex);
        }
        
        this.debug(`[智能更新] 所有 ${totalBlocks} 个块创建完成`);
    }

    /**
     * 分离表格块和非表格块
     * @param blocks 所有块
     * @returns 分离后的块
     */
    private separateTableBlocks(blocks: any[]): { tableBlocks: any[], nonTableBlocks: any[] } {
        const tableBlocks: any[] = [];
        const nonTableBlocks: any[] = [];
        
        for (const block of blocks) {
            if (block.block_type === 'table' || block.block_type === 31) {
                tableBlocks.push(block);
            } else {
                nonTableBlocks.push(block);
            }
        }
        
        return { tableBlocks, nonTableBlocks };
    }

    /**
     * 单独处理表格块（类似图片处理的逻辑）
     * @param documentId 文档ID
     * @param rootBlockId 根块ID
     * @param tableBlocks 表格块数组
     * @param startIndex 起始索引（非表格块的数量）
     */
    private async processTablesInDocument(documentId: string, rootBlockId: string, tableBlocks: any[], startIndex: number): Promise<void> {
        if (tableBlocks.length === 0) {
            this.debug('[智能更新] 没有表格需要处理');
            return;
        }

        this.debug(`[智能更新] 开始单独处理 ${tableBlocks.length} 个表格...`);
        
        let currentIndex = startIndex;
        let successCount = 0;
        let failureCount = 0;

        for (let i = 0; i < tableBlocks.length; i++) {
            const tableBlock = tableBlocks[i];
            
            try {
                this.debug(`[智能更新] 处理第 ${i + 1}/${tableBlocks.length} 个表格，索引位置: ${currentIndex}`);
                
                // 使用简化的表格创建方式
                await this.createSingleTableBlock(documentId, rootBlockId, tableBlock, currentIndex);
                
                successCount++;
                currentIndex++;
                
                this.debug(`[智能更新] 表格 ${i + 1} 创建成功`);
                
                // 添加延迟避免API频率限制
                if (i < tableBlocks.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
                
            } catch (error) {
                failureCount++;
                this.logError(`[智能更新] 表格 ${i + 1} 创建失败:`, error, {
                    documentId,
                    rootBlockId,
                    index: currentIndex
                });
                
                // 创建一个文本块来替代失败的表格
                try {
                    const fallbackBlock = {
                        block_type: 'text',
                        text: {
                            elements: [{
                                text_run: {
                                    content: `[表格创建失败] 原表格内容无法正确显示，请手动重新创建表格。错误信息: ${error instanceof Error ? error.message : String(error)}`
                                }
                            }]
                        }
                    };
                    
                    await this.feishuClient.createDocumentBlocks(
                        documentId,
                        rootBlockId,
                        currentIndex,
                        [fallbackBlock]
                    );
                    
                    currentIndex++;
                    this.debug(`[智能更新] 已创建错误提示文本块替代失败的表格`);
                    
                } catch (fallbackError) {
                    this.logError(`[智能更新] 创建错误提示文本块也失败:`, fallbackError, {
                        documentId,
                        rootBlockId,
                        index: currentIndex
                    });
                }
            }
        }

        this.debug(`[智能更新] 表格处理完成: 成功 ${successCount} 个，失败 ${failureCount} 个`);
        
        if (failureCount > 0) {
            console.warn(`[智能更新] 有 ${failureCount} 个表格创建失败，已用文本块替代`);
        }
    }

    /**
     * 创建单个表格块（简化版本）
     * @param documentId 文档ID
     * @param rootBlockId 根块ID
     * @param tableBlock 表格块
     * @param index 插入位置索引
     */
    private async createSingleTableBlock(documentId: string, rootBlockId: string, tableBlock: any, index: number): Promise<void> {
        try {
            // 方法1: 尝试直接创建完整表格（推荐方式）
            this.debug(`[智能更新] 尝试直接创建完整表格...`);
            
            // 简化表格块结构，移除可能导致问题的字段
            const simplifiedTableBlock = this.simplifyTableBlock(tableBlock);
            
            const result = await this.feishuClient.createDocumentBlocks(
                documentId,
                rootBlockId,
                index,
                [simplifiedTableBlock]
            );
            
            if (result?.children?.[0]?.block_id) {
                this.debug(`[智能更新] 表格直接创建成功，ID: ${result.children[0].block_id}`);
                return;
            }
            
            throw new Error('直接创建表格失败，返回结果无效');
            
        } catch (directError) {
            console.warn(`[智能更新] 直接创建表格失败，尝试分步创建:`, directError);
            
            // 方法2: 回退到分步创建方式
            await this.createTableBlockStepByStep(documentId, rootBlockId, tableBlock, index);
        }
    }

    /**
     * 简化表格块结构
     * @param tableBlock 原始表格块
     * @returns 简化后的表格块
     */
    private simplifyTableBlock(tableBlock: any): any {
        const simplified: any = {
            block_type: tableBlock.block_type,
            table: {
                property: {
                    row_size: tableBlock.table?.property?.row_size || 1,
                    column_size: tableBlock.table?.property?.column_size || 1
                }
            }
        };

        // 只在有子内容时才添加children
        if (tableBlock.children && tableBlock.children.length > 0) {
            simplified.children = this.simplifyTableChildren(tableBlock.children);
        }

        return simplified;
    }

    /**
     * 简化表格子块结构
     * @param children 原始子块数组
     * @returns 简化后的子块数组
     */
    private simplifyTableChildren(children: any[]): any[] {
        return children.map((child: any) => {
            const simplified: any = {
                block_type: child.block_type
            };

            // 根据块类型添加必要的属性
            if (child.block_type === 'table_row') {
                simplified.table_row = {};
            } else if (child.block_type === 'table_cell') {
                simplified.table_cell = {};
            }

            // 递归处理子块
            if (child.children && child.children.length > 0) {
                simplified.children = this.simplifyTableChildren(child.children);
            }

            return simplified;
        });
    }

    /**
     * 分步创建表格块（备用方案）
     * @param documentId 文档ID
     * @param rootBlockId 根块ID
     * @param tableBlock 表格块
     * @param index 插入位置索引
     */
    private async createTableBlockStepByStep(documentId: string, rootBlockId: string, tableBlock: any, index: number): Promise<void> {
        this.debug(`[智能更新] 开始分步创建表格...`);
        
        // 第一步：创建空表格框架
        const emptyTableBlock = this.createEmptyTableBlock(tableBlock);
        
        const createResult = await this.feishuClient.createDocumentBlocks(
            documentId,
            rootBlockId,
            index,
            [emptyTableBlock]
        );
        
        const createdTableBlockId = createResult?.children?.[0]?.block_id;
        if (!createdTableBlockId) {
            throw new Error('无法获取创建的表格块ID');
        }
        
        this.debug(`[智能更新] 空表格框架创建成功，ID: ${createdTableBlockId}`);
        
        // 第二步：添加表格内容（如果有）
        if (tableBlock.children && tableBlock.children.length > 0) {
            this.debug(`[智能更新] 开始添加表格内容...`);
            await this.addTableRowsAndCells(documentId, createdTableBlockId, tableBlock.children);
            this.debug(`[智能更新] 表格内容添加完成`);
        }
    }

    /**
     * 分批创建非表格块
     * @param documentId 文档ID
     * @param rootBlockId 根块ID
     * @param blocks 非表格块数组
     * @param startIndex 起始索引
     */
    private async createNonTableBlocksInBatches(documentId: string, rootBlockId: string, blocks: any[], startIndex: number): Promise<void> {
        const BATCH_SIZE = 50;
        let currentIndex = startIndex;
        
        for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
            const batch = blocks.slice(i, i + BATCH_SIZE);
            const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(blocks.length / BATCH_SIZE);
            
            this.debug(`[智能更新] 正在创建第 ${batchNumber}/${totalBatches} 批非表格块，包含 ${batch.length} 个块`);
            
            try {
                await this.feishuClient.createDocumentBlocks(
                    documentId,
                    rootBlockId,
                    currentIndex,
                    batch
                );
                
                currentIndex += batch.length;
                this.debug(`[智能更新] 第 ${batchNumber} 批非表格块创建成功`);
                
                // 添加延迟避免API频率限制
                if (i + BATCH_SIZE < blocks.length) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
            } catch (error) {
                this.logError(`[智能更新] 第 ${batchNumber} 批非表格块创建失败:`, error, {
                    documentId,
                    rootBlockId,
                    batchNumber,
                    batchSize: batch.length
                });
                throw new Error(`创建非表格块失败 (第${batchNumber}批): ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /**
     * 分步创建表格块（先创建空表格，再添加单元格内容）
     * @param documentId 文档ID
     * @param rootBlockId 根块ID
     * @param tableBlocks 表格块数组
     * @param startIndex 起始索引
     */
    private async createTableBlocksStepByStep(documentId: string, rootBlockId: string, tableBlocks: any[], startIndex: number): Promise<void> {
        let currentIndex = startIndex;
        
        for (const tableBlock of tableBlocks) {
            this.debug(`[智能更新] 开始分步创建表格块，索引位置: ${currentIndex}`);
            
            try {
                // 第一步：创建空表格块（移除所有子块）
                const emptyTableBlock = this.createEmptyTableBlock(tableBlock);
                
                this.debug(`[智能更新] 步骤1: 创建空表格块 (${emptyTableBlock.table.property.row_size}x${emptyTableBlock.table.property.column_size})`);
                const createResult = await this.feishuClient.createDocumentBlocks(
                    documentId,
                    rootBlockId,
                    currentIndex,
                    [emptyTableBlock]
                );
                
                // 获取创建的表格块ID
                const createdTableBlockId = createResult?.children?.[0]?.block_id;
                if (!createdTableBlockId) {
                    throw new Error('无法获取创建的表格块ID');
                }
                
                this.debug(`[智能更新] 步骤1完成: 空表格块已创建，ID: ${createdTableBlockId}`);
                
                // 第二步：为表格添加行和单元格内容
                if (tableBlock.children && tableBlock.children.length > 0) {
                    this.debug(`[智能更新] 步骤2: 为表格添加 ${tableBlock.children.length} 行内容`);
                    await this.addTableRowsAndCells(documentId, createdTableBlockId, tableBlock.children);
                    this.debug(`[智能更新] 步骤2完成: 表格内容已添加`);
                }
                
                currentIndex++;
                this.debug(`[智能更新] 表格块创建完成，下一个块索引: ${currentIndex}`);
                
                // 添加延迟避免API频率限制
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                this.logError(`[智能更新] 表格块创建失败:`, error, { documentId, rootBlockId, index: currentIndex });
                throw new Error(`创建表格块失败: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /**
     * 创建空表格块（移除所有子块内容）
     * @param tableBlock 原始表格块
     * @returns 空表格块
     */
    private createEmptyTableBlock(tableBlock: any): any {
        const emptyBlock = {
            block_type: tableBlock.block_type,
            table: {
                property: {
                    row_size: tableBlock.table?.property?.row_size || 1,
                    column_size: tableBlock.table?.property?.column_size || 1
                }
            }
        };
        
        // 确保没有merge_info字段
        if (tableBlock.table?.merge_info) {
            this.debug('[智能更新] 移除表格块中的merge_info字段');
        }
        
        return emptyBlock;
    }

    /**
     * 为表格添加行和单元格内容
     * @param documentId 文档ID
     * @param tableBlockId 表格块ID
     * @param tableRows 表格行数组
     */
    private async addTableRowsAndCells(documentId: string, tableBlockId: string, tableRows: any[]): Promise<void> {
        for (let rowIndex = 0; rowIndex < tableRows.length; rowIndex++) {
            const row = tableRows[rowIndex];
            
            this.debug(`[智能更新] 添加第 ${rowIndex + 1} 行，包含 ${row.children?.length || 0} 个单元格`);
            
            try {
                // 创建表格行
                const rowBlock = {
                    block_type: 'table_row',
                    table_row: {}
                };
                
                const rowResult = await this.feishuClient.createDocumentBlocks(
                    documentId,
                    tableBlockId,
                    rowIndex,
                    [rowBlock]
                );
                
                const createdRowBlockId = rowResult?.children?.[0]?.block_id;
                if (!createdRowBlockId) {
                    throw new Error(`无法获取创建的表格行ID (行${rowIndex + 1})`);
                }
                
                // 为行添加单元格
                if (row.children && row.children.length > 0) {
                    await this.addTableCells(documentId, createdRowBlockId, row.children);
                }
                
                // 添加延迟避免API频率限制
                await new Promise(resolve => setTimeout(resolve, 300));
                
            } catch (error) {
                this.logError(`[智能更新] 添加表格行失败 (行${rowIndex + 1}):`, error, {
                    documentId,
                    tableBlockId,
                    rowIndex
                });
                throw new Error(`添加表格行失败 (行${rowIndex + 1}): ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /**
     * 为表格行添加单元格
     * @param documentId 文档ID
     * @param rowBlockId 表格行块ID
     * @param tableCells 表格单元格数组
     */
    private async addTableCells(documentId: string, rowBlockId: string, tableCells: any[]): Promise<void> {
        for (let cellIndex = 0; cellIndex < tableCells.length; cellIndex++) {
            const cell = tableCells[cellIndex];
            
            try {
                // 创建表格单元格
                const cellBlock = {
                    block_type: 'table_cell',
                    table_cell: {},
                    children: cell.children || []
                };
                
                await this.feishuClient.createDocumentBlocks(
                    documentId,
                    rowBlockId,
                    cellIndex,
                    [cellBlock]
                );
                
                this.debug(`[智能更新] 单元格 ${cellIndex + 1} 创建成功`);
                
            } catch (error) {
                this.logError(`[智能更新] 添加表格单元格失败 (单元格${cellIndex + 1}):`, error, {
                    documentId,
                    rowBlockId,
                    cellIndex
                });
                throw new Error(`添加表格单元格失败 (单元格${cellIndex + 1}): ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /**
     * 处理Callout转换（复用原有上传流程的逻辑）
     * @param documentId 文档ID
     */
    private async processCalloutConversion(documentId: string): Promise<void> {
        try {
            // 获取文档所有块
            const blocks = await this.feishuClient.getDocumentBlocks(documentId);
            
            // 创建块映射，方便查找子块
            const blockMap = new Map<string, any>();
            blocks.forEach((block: any) => {
                blockMap.set(block.block_id, block);
            });
            
            // 为块添加索引信息
            const blocksWithIndex = blocks.map((block: any, index: number) => ({
                ...block,
                index: index
            }));
            
            // 查找quote块（callout在飞书中表现为quote块）
            const quoteBlocks = blocksWithIndex.filter((block: any) => block.block_type === 11); // 11表示quote块
            
            if (quoteBlocks.length === 0) {
                this.debug('[智能更新] 没有找到需要转换的Callout块');
                return;
            }
            
            this.debug(`[智能更新] 找到 ${quoteBlocks.length} 个Callout块需要转换`);
            
            // 逐个处理callout转换
            for (let i = 0; i < quoteBlocks.length; i++) {
                const quoteBlock = quoteBlocks[i];
                this.debug(`[智能更新] 正在转换第 ${i + 1}/${quoteBlocks.length} 个Callout...`);
                
                try {
                    // 准备Callout块的子块（保留原有内容，包括图片）
                    const childrenBlocks = this.prepareChildrenBlocks(quoteBlock, blockMap);
                    
                    // 创建callout块来替换quote块
                    const calloutBlock = {
                        block_type: 34, // 34表示callout块
                        callout: {
                            background_color: 1, // 默认背景色
                            border_color: 1,     // 默认边框色
                            text_color: 1        // 默认文字色
                        },
                        children: childrenBlocks // 包含原有子块
                    };
                    
                    // 在quote块位置插入callout块
                    await this.feishuClient.createDocumentBlocks(
                        documentId,
                        quoteBlock.parent_id || documentId,
                        quoteBlock.index,
                        [calloutBlock]
                    );
                    
                    // 删除原来的quote块
                    await this.feishuClient.deleteDocumentBlock(
                        documentId,
                        quoteBlock.block_id,
                        quoteBlock.parent_id,
                        quoteBlock.index
                    );
                    
                    // 添加延迟避免API频率限制
                    if (i < quoteBlocks.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                    
                } catch (error) {
                    console.warn(`[智能更新] 转换第 ${i + 1} 个Callout失败:`, error);
                    // 继续处理下一个，不中断整个流程
                }
            }
            
            this.debug('[智能更新] Callout转换处理完成');
            
        } catch (error) {
            console.warn('[智能更新] Callout转换过程中出现错误:', error);
            // 不抛出错误，因为callout转换失败不应该影响主要的上传流程
        }
    }

    /**
     * 准备块的子块用于创建（递归处理）
     * @param parentBlock 父块
     * @param blockMap 块ID映射
     * @returns 准备好的子块数组
     */
    private prepareChildrenBlocks(parentBlock: any, blockMap: Map<string, any>): any[] {
        if (!parentBlock.children || parentBlock.children.length === 0) {
            return [];
        }

        const result: any[] = [];
        
        for (const childId of parentBlock.children) {
            const childBlock = blockMap.get(childId);
            if (!childBlock) continue;
            
            // 复制块内容，排除特定字段
            const { block_id, parent_id, children, index, ...blockContent } = childBlock;
            const newBlock: any = { ...blockContent };
            
            // 递归处理子块的子块
            if (childBlock.children && childBlock.children.length > 0) {
                newBlock.children = this.prepareChildrenBlocks(childBlock, blockMap);
            }
            
            result.push(newBlock);
        }
        
        return result;
    }

    /**
     * 不支持创建的块类型列表（根据飞书API文档）
     */
    private readonly UNSUPPORTED_BLOCK_TYPES = new Set([
        'ai_template',      // AI 模板块 - 仅支持查询
        'source_synced',    // 源同步块 - 仅支持查询
        'reference_synced', // 引用同步块 - 仅支持查询
        'mindnote',         // 思维笔记块 - 不支持创建
        'undefined',        // 未定义块 - 无效操作
        'page',             // 页面块 - 文档创建时自动生成
        'view',             // 视图块 - 添加文件块时自动生成
        'diagram'           // 流程图 & UML 图 - 不支持创建
    ]);

    /**
     * 父子块类型限制映射（根据飞书API文档）
     */
    private readonly PARENT_CHILD_RESTRICTIONS = new Map([
        // 高亮块（Callout）限制
        ['callout', new Set(['text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'bullet', 'ordered', 'quote', 'code', 'equation', 'todo'])],
        
        // 分栏列（GridColumn）限制 - 不允许分栏、多维表格、OKR块
        ['grid_column', new Set(['text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'bullet', 'ordered', 'quote', 'code', 'equation', 'todo', 'image', 'table', 'callout'])],
        
        // 引用块（Quote）限制
        ['quote', new Set(['text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'bullet', 'ordered', 'code', 'equation', 'todo'])],
        
        // 代码块（Code）通常不包含子块
        ['code', new Set()],
        
        // 表格块（Table）只能包含表格行
        ['table', new Set(['table_row'])],
        
        // 表格行（TableRow）只能包含表格单元格
        ['table_row', new Set(['table_cell'])],
        
        // 表格单元格（TableCell）可以包含基础文本元素
        ['table_cell', new Set(['text', 'equation', 'mention_doc', 'mention_user'])]
    ]);

    /**
     * 检查块类型是否支持创建
     * @param blockType 块类型
     * @returns 是否支持创建
     */
    private isSupportedBlockType(blockType: string): boolean {
        return !this.UNSUPPORTED_BLOCK_TYPES.has(blockType);
    }

    /**
     * 验证父子块类型关系是否合法
     * @param parentBlockType 父块类型
     * @param childBlockType 子块类型
     * @returns 是否允许该父子关系
     */


    /**
     * 递归验证块及其子块的父子关系
     * @param block 要验证的块
     * @param parentBlockType 父块类型（可选）
     * @returns 验证结果和错误信息
     */
    private validateBlockHierarchy(block: any, parentBlockType?: string): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];
        
        // 验证当前块与父块的关系
        if (parentBlockType && !this.isValidParentChildRelation(parentBlockType, block.block_type)) {
            errors.push(`父块类型 "${parentBlockType}" 不支持子块类型 "${block.block_type}"`);
        }

        // 递归验证子块
        if (block.children && Array.isArray(block.children)) {
            for (const child of block.children) {
                const childValidation = this.validateBlockHierarchy(child, block.block_type);
                errors.push(...childValidation.errors);
            }
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * 验证文档访问权限（简化版本）
     * @param documentId 文档ID
     * @returns 验证结果
     */
    private async validateDocumentAccess(documentId: string): Promise<{ isValid: boolean; errors: string[] }> {
        const errors: string[] = [];
        
        try {
            // 智能更新模式：仅验证文档是否可访问
            // 由于是更新已存在的文档，无需复杂的权限检查
            const token = await this.feishuClient.getAccessToken();
            const url = `${this.feishuClient['baseUrl']}/docx/v1/documents/${documentId}`;
            
            const requestParam = {
                url,
                method: 'GET' as const,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            };

            const response = await requestUrl(requestParam);
            const result = response.json;

            if (result.code !== 0) {
                errors.push(`文档不可访问: ${result.msg || '未知错误'}`);
                return { isValid: false, errors };
            }

            this.debug('[智能更新] 文档访问验证通过');

        } catch (error: any) {
            this.logError('[智能更新] 文档访问验证失败:', error, { documentId });
            errors.push(`文档访问失败: ${error?.message || '网络错误'}`);
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * 测试创建权限（通过创建一个简单的文本块）
     * @param documentId 文档ID
     * @param rootBlockId 根块ID
     * @returns 权限测试结果
     */
    private async testCreatePermissions(documentId: string, rootBlockId: string): Promise<{ hasPermission: boolean; error?: string }> {
        try {
            // 创建一个简单的文本块进行权限测试
            const testBlock = {
                block_type: 'text',
                text: {
                    elements: [
                        {
                            text_run: {
                                content: '[权限测试]'
                            }
                        }
                    ]
                }
            };

            // 使用0作为index，表示插入到开头位置
            const result = await this.feishuClient.createDocumentBlocks(
                documentId,
                rootBlockId,
                0,
                [testBlock]
            );

            if (result?.children?.[0]?.block_id) {
                // 测试成功，立即删除测试块
                const createdBlockId = result.children[0].block_id;
                try {
                    await this.feishuClient.deleteDocumentBlock(documentId, createdBlockId);
                } catch (deleteError) {
                    console.warn('[智能更新] 删除测试块失败，但不影响权限验证:', deleteError);
                }
                this.debug('[智能更新] 创建权限测试通过');
                return { hasPermission: true };
            } else {
                console.warn('[智能更新] 创建权限测试失败: 未返回块ID');
                return { 
                    hasPermission: false, 
                    error: '权限不足或文档不支持创建块'
                };
            }

        } catch (error: any) {
            this.logError('[智能更新] 权限测试异常:', error, { documentId, rootBlockId });
            
            // 如果是400错误，可能是文档不支持编辑或权限不足
            if (error?.message?.includes('400') || error?.message?.includes('Request failed, status 400')) {
                return { 
                    hasPermission: false, 
                    error: '文档不支持编辑或权限不足，请检查文档权限设置'
                };
            }
            
            return { 
                hasPermission: false, 
                error: `权限测试失败: ${error?.message || '未知错误'}`
            };
        }
    }



    /**
     * 验证和修正块顺序（根据官方建议）
     * @param blocks 转换API返回的块数组
     * @param originalMarkdown 原始Markdown内容
     * @returns 修正后的块数组
     */
    private validateAndFixBlockOrder(blocks: any[], originalMarkdown: string): any[] {
        this.debug('[智能更新] 开始验证和修正块顺序...');
        
        // 1. 解析原始Markdown的结构顺序
        const markdownStructure = this.parseMarkdownStructure(originalMarkdown);
        this.debug('[智能更新] 原始Markdown结构:', markdownStructure);
        
        // 2. 分析转换后的块结构
        const blockStructure = blocks.map((block, index) => ({
            index,
            type: block.block_type,
            content: this.getBlockContentPreview(block),
            block
        }));
        this.debug('[智能更新] 转换后块结构:', blockStructure);
        
        // 3. 使用改进的匹配算法重新排序块
        const reorderedBlocks = this.reorderBlocksByImprovedMatching(blocks, markdownStructure);
        
        this.debug('[智能更新] 块顺序修正完成');
        this.debug('[智能更新] 修正后的块顺序:');
        reorderedBlocks.forEach((block: any, index: number) => {
            this.debug(`  [${index}] 类型: ${block.block_type}, 内容: ${this.getBlockContentPreview(block)}`);
        });
        
        return reorderedBlocks;
    }

    /**
     * 解析Markdown结构顺序
     * @param markdown Markdown内容
     * @returns 结构信息数组
     */
    private parseMarkdownStructure(markdown: string): Array<{type: string, content: string, line: number}> {
        const lines = markdown.split('\n');
        const structure: Array<{type: string, content: string, line: number}> = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i] || '';
            const trimmedLine = line.trim();
            
            // 跳过空行，但保留有内容的行（包括只有符号的行）
            if (!trimmedLine) continue;
            
            let type = 'text';
            let content = trimmedLine;
            
            // 识别不同类型的Markdown元素
            if (trimmedLine.startsWith('# ')) {
                type = 'heading1';
                content = trimmedLine.substring(2).trim();
            } else if (trimmedLine.startsWith('## ')) {
                type = 'heading2';
                content = trimmedLine.substring(3).trim();
            } else if (trimmedLine.startsWith('### ')) {
                type = 'heading3';
                content = trimmedLine.substring(4).trim();
            } else if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('* ')) {
                type = 'bullet';
                content = trimmedLine.substring(2).trim();
            } else if (/^\d+\.\s/.test(trimmedLine)) {
                type = 'ordered';
                content = trimmedLine.replace(/^\d+\.\s/, '').trim();
            } else if (trimmedLine.startsWith('> ')) {
                type = 'quote';
                content = trimmedLine.substring(2).trim();
            } else if (trimmedLine === '>') {
                // 特殊处理：单独的">"符号
                type = 'text';
                content = '>';
            } else if (trimmedLine.startsWith('```')) {
                type = 'code';
                content = '[代码块]';
            } else if (trimmedLine.includes('![') && trimmedLine.includes('](')) {
                type = 'image';
                content = '[图片]';
            }
            
            structure.push({ type, content: content.substring(0, 50), line: i });
        }
        
        return structure;
    }

    /**
     * 使用基于内容相似度的智能匹配重新排序块
     * @param blocks 飞书块数组
     * @param markdownStructure Markdown结构数组
     * @returns 重新排序后的块数组
     */
    private reorderBlocksByImprovedMatching(blocks: any[], markdownStructure: Array<{type: string, content: string, line: number}>): any[] {
        this.debug('[智能更新] 开始基于内容相似度的智能匹配算法...');
        this.debug(`[匹配信息] 飞书块数量: ${blocks.length}, Markdown结构数量: ${markdownStructure.length}`);
        
        const reorderedBlocks: any[] = [];
        const usedBlockIndices = new Set<number>();
        
        // 为每个Markdown结构元素找到最佳匹配的飞书块
        for (let structIndex = 0; structIndex < markdownStructure.length; structIndex++) {
            const struct = markdownStructure[structIndex];
            if (!struct) continue; // 跳过空值
            
            let bestMatch = -1;
            let bestScore = 0;
            
            // 遍历所有未使用的飞书块，找到最佳匹配
            for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
                if (usedBlockIndices.has(blockIndex)) continue;
                
                const block = blocks[blockIndex];
                const score = this.calculateContentMatchScore(block, struct);
                
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = blockIndex;
                }
            }
            
            // 如果找到了匹配（得分大于阈值）
            if (bestMatch !== -1 && bestScore >= 0.5) {
                const matchedBlock = blocks[bestMatch];
                reorderedBlocks.push(matchedBlock);
                usedBlockIndices.add(bestMatch);
                
                const blockContent = this.getBlockContentPreview(matchedBlock);
                this.debug(`[智能匹配] Markdown[${structIndex}]: "${struct.content}" -> 飞书块[${bestMatch}]: "${blockContent}" (得分: ${bestScore.toFixed(2)})`);
            } else {
                this.debug(`[未匹配] Markdown[${structIndex}]: "${struct.content}" - 未找到合适的飞书块匹配`);
            }
        }
        
        // 将未匹配的飞书块添加到末尾
        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
            if (!usedBlockIndices.has(blockIndex)) {
                reorderedBlocks.push(blocks[blockIndex]);
                const blockContent = this.getBlockContentPreview(blocks[blockIndex]);
                this.debug(`[剩余块] 添加飞书块[${blockIndex}]: "${blockContent}" 到末尾`);
            }
        }
        
        this.debug(`[匹配结果] 成功匹配: ${usedBlockIndices.size}/${blocks.length} 个飞书块`);
        return reorderedBlocks;
    }

    /**
     * 计算内容匹配得分
     * @param block 飞书块
     * @param struct Markdown结构元素
     * @returns 匹配得分 (0-1)
     */
    private calculateContentMatchScore(block: any, struct: {type: string, content: string, line: number}): number {
        const blockContent = this.getBlockContentPreview(block);
        if (!blockContent || !struct.content) return 0;
        
        // 1. 精确匹配检查 (最高优先级)
        const cleanBlockContent = this.cleanContentForComparison(blockContent);
        const cleanStructContent = this.cleanContentForComparison(struct.content);
        
        if (cleanBlockContent === cleanStructContent) {
            return 1.0; // 完全匹配
        }
        
        // 2. 类型匹配检查
        const blockType = this.mapBlockTypeToMarkdown(block.block_type);
        let typeScore = 0;
        
        if (blockType === struct.type) {
            // 对于列表类型，给予更高的基础分，以便在内容不完全匹配时也能保持相对顺序
            // 解决列表项修改后顺序丢失的问题
            if (['ordered', 'bullet'].includes(blockType)) {
                typeScore = 0.6;
            } else {
                typeScore = 0.4;
            }
        } else {
            // 特殊处理：callout块可能被识别为quote类型15
            if (struct.type === 'quote' && block.block_type === 15) {
                if (blockContent.includes('[!')) {
                    typeScore = 0.35; // callout匹配
                } else {
                    typeScore = 0.4; // 普通quote匹配
                }
            }
        }
        
        // 3. 内容相似度检查 (只有类型匹配时才进行详细内容比较)
        if (typeScore > 0) {
            const contentScore = this.calculateAdvancedContentSimilarity(blockContent, struct.content);
            return typeScore + contentScore * 0.6;
        }
        
        // 4. 如果类型不匹配，只有在内容高度相似时才给分
        const contentScore = this.calculateAdvancedContentSimilarity(blockContent, struct.content);
        if (contentScore > 0.8) {
            return contentScore * 0.5; // 降低权重
        }
        
        return 0;
    }

    /**
     * 计算高级内容相似度
     * @param content1 内容1
     * @param content2 内容2
     * @returns 相似度 (0-1)
     */
    private calculateAdvancedContentSimilarity(content1: string, content2: string): number {
        if (!content1 || !content2) return 0;
        
        // 清理内容，移除格式标记
        const clean1 = this.cleanContentForComparison(content1);
        const clean2 = this.cleanContentForComparison(content2);
        
        if (clean1 === clean2) return 1;
        
        // 长度差异过大，直接返回低分
        const lengthRatio = Math.min(clean1.length, clean2.length) / Math.max(clean1.length, clean2.length);
        if (lengthRatio < 0.3) return 0;
        
        // 检查包含关系 (更严格的条件)
        if (clean1.includes(clean2) && clean2.length >= 3) {
            return 0.8;
        }
        if (clean2.includes(clean1) && clean1.length >= 3) {
            return 0.8;
        }
        
        // 计算词汇重叠度 (更严格的评分)
        const words1 = clean1.split(/\s+/).filter(w => w.length > 1); // 过滤单字符词
        const words2 = clean2.split(/\s+/).filter(w => w.length > 1);
        
        if (words1.length === 0 || words2.length === 0) {
            // 如果没有有效词汇，使用字符相似度
            return this.calculateCharacterSimilarity(clean1, clean2);
        }
        
        const commonWords = words1.filter(word => words2.includes(word));
        const overlapRatio = commonWords.length / Math.max(words1.length, words2.length);
        
        // 更严格的评分标准
        if (commonWords.length === 0) return 0;
        
        // 要求更高的重叠度才给高分
        if (overlapRatio >= 0.8) return 0.9;
        if (overlapRatio >= 0.6) return 0.7;
        if (overlapRatio >= 0.4) return 0.5;
        if (overlapRatio >= 0.2) return 0.3;
        
        return 0.1;
    }

    /**
     * 清理内容用于比较
     * @param content 原始内容
     * @returns 清理后的内容
     */
    private cleanContentForComparison(content: string): string {
        let cleaned = content.toLowerCase().trim();
        
        // 特殊处理：保留重要的单字符内容
        if (cleaned.length <= 2) {
            return cleaned;
        }
        
        // 移除标题和列表标记，但保留内容
        cleaned = cleaned
            .replace(/^(h\d+:\s*)/i, '') // 移除标题标记
            .replace(/^(\d+\.\s*)/i, '') // 移除有序列表标记
            .replace(/^(-\s*|\*\s*)/i, '') // 移除无序列表标记
            .replace(/[^\w\s\u4e00-\u9fff>!]/g, '') // 保留字母、数字、空格、中文和重要符号
            .trim();
        
        return cleaned;
    }

    /**
     * 计算字符相似度
     * @param str1 字符串1
     * @param str2 字符串2
     * @returns 相似度 (0-1)
     */
    private calculateCharacterSimilarity(str1: string, str2: string): number {
        if (str1.length === 0 && str2.length === 0) return 1;
        if (str1.length === 0 || str2.length === 0) return 0;
        
        const maxLength = Math.max(str1.length, str2.length);
        const distance = this.levenshteinDistance(str1, str2);
        
        return Math.max(0, (maxLength - distance) / maxLength);
    }

    /**
     * 计算编辑距离
     * @param str1 字符串1
     * @param str2 字符串2
     * @returns 编辑距离
     */
    private levenshteinDistance(str1: string, str2: string): number {
        const matrix: number[][] = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(0));
        
        for (let i = 0; i <= str1.length; i++) matrix[0]![i] = i;
        for (let j = 0; j <= str2.length; j++) matrix[j]![0] = j;
        
        for (let j = 1; j <= str2.length; j++) {
            for (let i = 1; i <= str1.length; i++) {
                const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
                matrix[j]![i] = Math.min(
                    matrix[j]![i - 1]! + 1,     // deletion
                    matrix[j - 1]![i]! + 1,     // insertion
                    matrix[j - 1]![i - 1]! + indicator // substitution
                );
            }
        }
        
        return matrix[str2.length]![str1.length]!;
    }



    /**
     * 获取块内容预览（用于调试）
     * @param block 块对象
     * @returns 内容预览字符串
     */
    private getBlockContentPreview(block: any): string {
        try {
            if (block.text?.elements) {
                const textContent = block.text.elements
                    .filter((el: any) => el.text_run?.content)
                    .map((el: any) => el.text_run.content)
                    .join('');
                return textContent.substring(0, 50) + (textContent.length > 50 ? '...' : '');
            }
            
            if (block.heading1?.elements) {
                const headingContent = block.heading1.elements
                    .filter((el: any) => el.text_run?.content)
                    .map((el: any) => el.text_run.content)
                    .join('');
                return `H1: ${headingContent.substring(0, 40)}${headingContent.length > 40 ? '...' : ''}`;
            }
            
            if (block.heading2?.elements) {
                const headingContent = block.heading2.elements
                    .filter((el: any) => el.text_run?.content)
                    .map((el: any) => el.text_run.content)
                    .join('');
                return `H2: ${headingContent.substring(0, 40)}${headingContent.length > 40 ? '...' : ''}`;
            }
            
            if (block.heading3?.elements) {
                const headingContent = block.heading3.elements
                    .filter((el: any) => el.text_run?.content)
                    .map((el: any) => el.text_run.content)
                    .join('');
                return `H3: ${headingContent.substring(0, 40)}${headingContent.length > 40 ? '...' : ''}`;
            }
            
            if (block.bullet?.elements) {
                const bulletContent = block.bullet.elements
                    .filter((el: any) => el.text_run?.content)
                    .map((el: any) => el.text_run.content)
                    .join('');
                return `• ${bulletContent.substring(0, 40)}${bulletContent.length > 40 ? '...' : ''}`;
            }
            
            if (block.ordered?.elements) {
                const orderedContent = block.ordered.elements
                    .filter((el: any) => el.text_run?.content)
                    .map((el: any) => el.text_run.content)
                    .join('');
                return `1. ${orderedContent.substring(0, 40)}${orderedContent.length > 40 ? '...' : ''}`;
            }
            
            if (block.quote?.elements) {
                const quoteContent = block.quote.elements
                    .filter((el: any) => el.text_run?.content)
                    .map((el: any) => el.text_run.content)
                    .join('');
                return `> ${quoteContent.substring(0, 40)}${quoteContent.length > 40 ? '...' : ''}`;
            }
            
            if (block.image) {
                return `[图片]`;
            }
            
            if (block.code?.language) {
                return `[代码块: ${block.code.language}]`;
            }
            
            return `[${block.block_type}]`;
        } catch (error) {
            return `[${block.block_type}] (解析错误)`;
        }
    }

    /**
     * 处理块数据，为插入做准备
     * @param blocks 原始块数据
     * @param parentBlockType 父块类型（用于验证父子关系）
     * @returns 处理后的块数据
     */
    private processBlocksForInsertion(blocks: any[], parentBlockType?: string): any[] {
        const processBlock = (block: any, parentType?: string): any | null => {
            // 检查块类型是否支持创建
            if (!this.isSupportedBlockType(block.block_type)) {
                console.warn(`[智能更新] 跳过不支持创建的块类型: ${block.block_type}`);
                return null;
            }

            // 验证父子块类型关系
            if (parentType && !this.isValidParentChildRelation(parentType, block.block_type)) {
                console.warn(`[智能更新] 跳过不合法的父子块关系: 父块 "${parentType}" 不支持子块 "${block.block_type}"`);
                return null;
            }

            let processedBlock = { ...block };
            
            // 处理表格块
            if (block.block_type === 'table' && block.table) {
                // 移除表格块中的merge_info字段（根据飞书文档要求）
                if (block.table.merge_info) {
                    delete processedBlock.table.merge_info;
                }
                
                // 验证和设置表格块必需参数
                if (!processedBlock.table.property) {
                    processedBlock.table.property = {};
                }
                
                // 确保row_size和column_size参数存在且有效
                if (!processedBlock.table.property.row_size || processedBlock.table.property.row_size <= 0) {
                    processedBlock.table.property.row_size = Math.min(
                        Math.max(1, processedBlock.table.property.row_size || 1), 
                        9  // 飞书表格最大行数限制
                    );
                    this.debug(`[智能更新] 表格块缺少row_size参数，已设置为: ${processedBlock.table.property.row_size}`);
                }
                
                if (!processedBlock.table.property.column_size || processedBlock.table.property.column_size <= 0) {
                    processedBlock.table.property.column_size = Math.min(
                        Math.max(1, processedBlock.table.property.column_size || 1), 
                        9  // 飞书表格最大列数限制
                    );
                    this.debug(`[智能更新] 表格块缺少column_size参数，已设置为: ${processedBlock.table.property.column_size}`);
                }
                
                // 验证单元格总数不超过2000
                const totalCells = processedBlock.table.property.row_size * processedBlock.table.property.column_size;
                if (totalCells > 2000) {
                    console.warn(`[智能更新] 表格单元格总数 ${totalCells} 超过限制 2000，将调整表格大小`);
                    // 按比例缩小表格，保持长宽比
                    const ratio = Math.sqrt(2000 / totalCells);
                    processedBlock.table.property.row_size = Math.max(1, Math.floor(processedBlock.table.property.row_size * ratio));
                    processedBlock.table.property.column_size = Math.max(1, Math.floor(processedBlock.table.property.column_size * ratio));
                    this.debug(`[智能更新] 表格大小已调整为: ${processedBlock.table.property.row_size}x${processedBlock.table.property.column_size}`);
                }
            }
            
            // 处理电子表格块（Sheet）
            if (block.block_type === 'sheet' && block.sheet) {
                if (!processedBlock.sheet.row_size || processedBlock.sheet.row_size <= 0) {
                    processedBlock.sheet.row_size = Math.min(
                        Math.max(1, processedBlock.sheet.row_size || 1), 
                        9  // 飞书电子表格最大行数限制
                    );
                    this.debug(`[智能更新] 电子表格块缺少row_size参数，已设置为: ${processedBlock.sheet.row_size}`);
                }
                
                if (!processedBlock.sheet.column_size || processedBlock.sheet.column_size <= 0) {
                    processedBlock.sheet.column_size = Math.min(
                        Math.max(1, processedBlock.sheet.column_size || 1), 
                        9  // 飞书电子表格最大列数限制
                    );
                    this.debug(`[智能更新] 电子表格块缺少column_size参数，已设置为: ${processedBlock.sheet.column_size}`);
                }
            }
            
            // 递归处理子块
            if (processedBlock.children && Array.isArray(processedBlock.children)) {
                const processedChildren = processedBlock.children
                    .map((child: any) => processBlock(child, processedBlock.block_type))
                    .filter((child: any) => child !== null);
                
                if (processedChildren.length > 0) {
                    processedBlock.children = processedChildren;
                } else {
                    delete processedBlock.children;
                }
            }
            
            return processedBlock;
        };

        return blocks.map(block => processBlock(block, parentBlockType)).filter(block => block !== null);
    }

    /**
     * 执行智能更新
     * @param title 文档标题
     * @param markdownContent Markdown内容
     * @param uploadHistory 上传历史记录
     * @param onProgress 进度回调
     * @returns 更新结果
     */
    async performSmartUpdate(
        title: string,
        markdownContent: string,
        uploadHistory: any[],
        onProgress?: (message: string) => void,
        orderedImageInfos?: any[],
        yamlInfo?: any
    ): Promise<SmartUpdateResult> {
        try {
            onProgress?.('正在查找已存在的文档...');
            
            // 步骤1: 检查是否存在同名文档
            const existingDoc = this.findExistingDocument(title, uploadHistory);
            
            if (!existingDoc) {
                return {
                    success: false,
                    documentId: '',
                    url: '',
                    error: '未找到同名文档，无法执行智能更新'
                };
            }
            
            this.debug('[智能更新] 找到同名文档:', existingDoc);
            onProgress?.('📄 找到已存在文档，正在准备更新...');
            
            // 步骤2: 获取文档根块ID
            onProgress?.('🔧 正在获取文档结构信息...');
            const rootBlockId = await this.getDocumentRootBlockId(existingDoc.docToken);
            
            // 步骤3: 删除所有子块
            onProgress?.('正在清空原有内容...');
            await this.deleteAllChildBlocks(existingDoc.docToken, rootBlockId);
            
            // 步骤4: 重新导入内容
            onProgress?.('正在更新文档内容...');
            await this.reimportContent(existingDoc.docToken, rootBlockId, markdownContent, orderedImageInfos, yamlInfo);
            
            onProgress?.('文档更新完成！');
            
            return {
                success: true,
                documentId: existingDoc.docToken,
                url: existingDoc.url
            };
            
        } catch (error) {
            this.logError('[智能更新] 执行失败:', error, { title });
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            return {
                success: false,
                documentId: '',
                url: '',
                error: `智能更新失败: ${errorMessage}`
            };
        }
    }

    /**
     * 检测Markdown内容中是否包含表格
     * @param markdownContent Markdown内容
     * @returns 是否包含表格
     */
    private hasTableInMarkdown(markdownContent: string): boolean {
        const lines = markdownContent.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]?.trim() || '';
            
            // 检测表格行（包含 | 分隔符）
            if (line.includes('|') && line.length > 2) {
                // 确保不是代码块中的内容
                const beforeLines = lines.slice(0, i);
                const codeBlockCount = beforeLines.filter(l => l.trim().startsWith('```')).length;
                
                // 如果代码块数量是偶数，说明当前行不在代码块中
                if (codeBlockCount % 2 === 0) {
                    // 检查是否为有效的表格行
                    const cells = line.split('|').map(cell => cell.trim());
                    if (cells.length >= 3) { // 至少包含两个有效列（首尾可能为空）
                        return true;
                    }
                }
            }
        }
        
        return false;
    }

    /**
     * 检查是否应该使用智能更新
     * @param title 文档标题
     * @param uploadHistory 上传历史记录
     * @param enableSmartUpdate 是否启用智能更新
     * @param markdownContent Markdown内容（用于表格检测）
     * @returns 是否应该使用智能更新
     */
    shouldUseSmartUpdate(title: string, uploadHistory: any[], enableSmartUpdate: boolean, markdownContent?: string): boolean {
        if (!enableSmartUpdate) {
            return false;
        }
        
        // 如果提供了Markdown内容，检测是否包含表格
        if (markdownContent && this.hasTableInMarkdown(markdownContent)) {
            this.debug('[智能更新] 检测到表格内容，自动切换到普通上传模式');
            return false;
        }
        
        return this.findExistingDocument(title, uploadHistory) !== null;
    }

    /**
     * 预处理Markdown内容，在普通文本行之间添加空行以便更好地分离块
     * @param markdown Markdown内容
     * @returns 处理后的Markdown内容
     */
    private preprocessMarkdownForBlockSeparation(markdown: string): string {
        const lines = markdown.split('\n');
        const processedLines: string[] = [];
        
        for (let i = 0; i < lines.length; i++) {
            const currentLine = lines[i] || '';
            const nextLine = lines[i + 1];
            
            processedLines.push(currentLine);
            
            // 如果当前行和下一行都是普通文本行，则在它们之间添加空行
            if (currentLine && nextLine && 
                this.isPlainTextLine(currentLine) && 
                this.isPlainTextLine(nextLine)) {
                processedLines.push('');
            }
        }
        
        return processedLines.join('\n');
    }

    /**
     * 判断是否为普通文本行（非Markdown特殊格式）
     * @param line 文本行
     * @returns 是否为普通文本行
     */
    private isPlainTextLine(line: string): boolean {
        const trimmed = line.trim();
        if (!trimmed) return false;
        
        const specialFormats = [
            /^#{1,6}\s/,        // 标题
            /^\s*[-*+]\s/,      // 无序列表
            /^\s*\d+\.\s/,      // 有序列表
            /^>/,               // 引用
            /^```/,             // 代码块
            /^\s*\|.*\|/,       // 表格
            /^!\[.*\]\(.*\)/,   // 图片
            /^\[.*\]\(.*\)/,    // 链接
            /^---+$/,           // 分隔线
            /^\s*$/             // 空行
        ];
        
        return !specialFormats.some(pattern => pattern.test(trimmed));
    }

    /**
     * 将飞书块类型映射到Markdown类型
     * @param blockType 飞书块类型（可能是数字或字符串）
     * @returns Markdown类型
     */
    private mapBlockTypeToMarkdown(blockType: number | string): string {
        const numericMapping: { [key: number]: string } = {
            2: 'text',      // 普通文本
            3: 'heading1',  // 一级标题
            4: 'heading2',  // 二级标题
            5: 'heading3',  // 三级标题
            13: 'ordered',  // 有序列表
            14: 'bullet',   // 无序列表
            15: 'quote',    // 引用
            16: 'code',     // 代码块
            27: 'image',    // 图片
            31: 'table'     // 表格（根据飞书官方文档）
        };

        const stringMapping: { [key: string]: string } = {
            'text': 'text',
            'heading1': 'heading1',
            'heading2': 'heading2',
            'heading3': 'heading3',
            'bullet': 'bullet',
            'ordered': 'ordered',
            'quote': 'quote',
            'code': 'code',
            'image': 'image',
            'table': 'table',
            'table_row': 'table_row',
            'table_cell': 'table_cell'
        };

        // 如果是数字类型
        if (typeof blockType === 'number') {
            return numericMapping[blockType] || 'text';
        }

        // 尝试转换为数字
        const numericType = parseInt(blockType.toString());
        if (!isNaN(numericType) && numericMapping[numericType]) {
            return numericMapping[numericType];
        }

        // 字符串映射
        return stringMapping[blockType] || 'text';
    }

    /**
     * 验证和修正parent_id和children关系
     * @param blocks 块数组
     * @returns 修正后的块数组
     */
    private validateAndFixParentChildRelations(blocks: any[]): any[] {
        this.debug('[智能更新] 开始验证和修正parent_id和children关系...');
        
        const blockMap = new Map();
        const fixedBlocks = blocks.map(block => ({ ...block }));
        
        // 建立块ID映射
        fixedBlocks.forEach(block => {
            if (block.block_id) {
                blockMap.set(block.block_id, block);
            }
        });
        
        // 验证和修正关系
        fixedBlocks.forEach(block => {
            // 验证parent_id
            if (block.parent_id && !blockMap.has(block.parent_id)) {
                console.warn(`[智能更新] 块 ${block.block_id} 的parent_id ${block.parent_id} 不存在，将清除parent_id`);
                delete block.parent_id;
            }
            
            // 验证children
            if (block.children && Array.isArray(block.children)) {
                const validChildren: any[] = [];
                block.children.forEach((child: any, index: number) => {
                    if (child.block_id && blockMap.has(child.block_id)) {
                        const childBlock = blockMap.get(child.block_id);
                        if (childBlock && childBlock.parent_id !== block.block_id) {
                            this.debug(`[智能更新] 修正子块 ${child.block_id} 的parent_id: ${childBlock.parent_id} -> ${block.block_id}`);
                            childBlock.parent_id = block.block_id;
                        }
                        validChildren.push(child);
                    } else {
                        console.warn(`[智能更新] 块 ${block.block_id} 的子块 ${child.block_id} 不存在，将从children中移除`);
                    }
                });
                
                block.children = validChildren;
                if (block.children.length === 0) {
                    delete block.children;
                }
            }
            
            // 验证父子关系的有效性
            if (block.parent_id) {
                const parentBlock = blockMap.get(block.parent_id);
                if (parentBlock && !this.isValidParentChildRelation(parentBlock.block_type, block.block_type)) {
                    console.warn(`[智能更新] 无效的父子关系: ${parentBlock.block_type} -> ${block.block_type}`);
                    delete block.parent_id;
                }
            }
        });
        
        this.debug('[智能更新] parent_id和children关系验证修正完成');
        return fixedBlocks;
    }

    /**
     * 验证父子关系是否有效
     * @param parentType 父块类型
     * @param childType 子块类型
     * @returns 是否为有效的父子关系
     */
    private isValidParentChildRelation(parentType: number | string, childType: number | string): boolean {
        // 将类型转换为标准字符串
        const parentMdType = this.mapBlockTypeToMarkdown(parentType);
        const childMdType = this.mapBlockTypeToMarkdown(childType);
        
        // 定义有效的父子关系
        const validRelations: { [key: string]: string[] } = {
            'ordered': ['text', 'ordered', 'bullet'],
            'bullet': ['text', 'ordered', 'bullet'],
            'quote': ['text', 'heading1', 'heading2', 'heading3', 'ordered', 'bullet', 'quote'],
            'text': []  // 普通文本通常不包含子元素
        };
        
        return validRelations[parentMdType]?.includes(childMdType) || false;
    }

    /**
     * 处理YAML信息块插入
     * @param documentId 文档ID
     * @param yamlInfo YAML信息
     */
    private async processYamlInsertion(documentId: string, yamlInfo: any): Promise<void> {
        try {
            const yamlProcessor = new YamlProcessor(this.feishuClient);
            
            // 等待一下确保文档完全同步
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // 在文档开头插入YAML信息块
            await yamlProcessor.insertYamlBlockInDocument(documentId, yamlInfo, 0);
            
        } catch (error) {
            this.logError('[智能更新] YAML 处理失败:', error, { documentId });
            // YAML处理失败不影响主流程，只记录错误
        }
    }
}
