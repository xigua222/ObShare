import { FeishuApiClient, DocumentBlock } from './feishu-api';

/**
 * 高亮信息接口
 */
export interface HighlightInfo {
    text: string;       // 高亮文本内容
    color: number;      // 飞书背景色枚举 (1-7)
    lineContext: string; // 高亮所在行的纯文本（剥离标签后），用于定位
}

/**
 * 高亮转换器
 * 负责提取 Markdown 中的高亮语法、剥离标签、上传后通过飞书 Block API 应用背景色
 */
export class HighlightConverter {
    private feishuClient: FeishuApiClient;
    private static debugEnabled = false;

    static setDebugEnabled(enabled: boolean): void {
        this.debugEnabled = enabled;
    }

    private debug(...args: unknown[]): void {
        if (HighlightConverter.debugEnabled) {
            console.debug(...args);
        }
    }

    private logError(summary: string, error: unknown, details?: Record<string, unknown>): void {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(summary, errorMessage);
        this.debug(`${summary} 详情:`, { ...details, error, errorMessage });
    }

    constructor(feishuClient: FeishuApiClient) {
        this.feishuClient = feishuClient;
    }

    // CSS 颜色名 → 飞书枚举
    private static readonly COLOR_MAP: Record<string, number> = {
        'red': 1, 'orange': 2, 'yellow': 3, 'green': 4,
        'blue': 5, 'purple': 6, 'gray': 7, 'grey': 7,
    };

    // 常见 hex → 飞书枚举
    private static readonly HEX_MAP: Record<string, number> = {
        '#ff0000': 1, '#ff4500': 2, '#ffa500': 2, '#ffff00': 3,
        '#00ff00': 4, '#008000': 4, '#0000ff': 5, '#800080': 6,
        '#808080': 7,
    };

    private static readonly DEFAULT_COLOR = 3; // 黄色

    // 正则：<mark style="background-color: COLOR">text</mark>
    private static readonly MARK_STYLE_REGEX = /<mark\s+style\s*=\s*"[^"]*background-color:\s*([^;"]+)[^"]*"\s*>([\s\S]*?)<\/mark>/gi;
    // 正则：<mark>text</mark>（无 style）
    private static readonly MARK_PLAIN_REGEX = /<mark>([\s\S]*?)<\/mark>/gi;
    // 正则：==text==（Obsidian 原生高亮）
    private static readonly DOUBLE_EQUAL_REGEX = /==((?:(?!==).)+)==/g;

    /**
     * CSS 颜色值映射到飞书枚举
     */
    static mapCssColorToFeishu(color: string): number {
        const c = color.trim().toLowerCase();
        if (this.COLOR_MAP[c] !== undefined) return this.COLOR_MAP[c];
        if (this.HEX_MAP[c] !== undefined) return this.HEX_MAP[c];
        return this.DEFAULT_COLOR;
    }

    /**
     * 剥离一行中所有高亮语法，返回纯文本
     */
    private static stripLine(line: string): string {
        return line
            .replace(/<mark\s+style\s*=\s*"[^"]*"\s*>([\s\S]*?)<\/mark>/gi, '$1')
            .replace(/<mark>([\s\S]*?)<\/mark>/gi, '$1')
            .replace(/==((?:(?!==).)+)==/g, '$1');
    }

    /**
     * 从 Markdown 中提取所有高亮信息
     */
    extractHighlights(markdown: string): HighlightInfo[] {
        const highlights: HighlightInfo[] = [];
        const lines = markdown.split('\n');

        for (const line of lines) {
            const lineContext = HighlightConverter.stripLine(line).trim();
            if (!lineContext) continue;

            // <mark style="background-color: COLOR">text</mark>
            let match;
            HighlightConverter.MARK_STYLE_REGEX.lastIndex = 0;
            while ((match = HighlightConverter.MARK_STYLE_REGEX.exec(line)) !== null) {
                const text = match[2] || '';
                const colorStr = match[1] || '';
                highlights.push({
                    text,
                    color: HighlightConverter.mapCssColorToFeishu(colorStr),
                    lineContext
                });
            }

            // <mark>text</mark>（排除已被 style 版本匹配的）
            HighlightConverter.MARK_PLAIN_REGEX.lastIndex = 0;
            while ((match = HighlightConverter.MARK_PLAIN_REGEX.exec(line)) !== null) {
                // 检查这个位置是否已被 style 版本覆盖
                const fullTag = match[0];
                if (fullTag.includes('style')) continue;
                highlights.push({
                    text: match[1] || '',
                    color: HighlightConverter.DEFAULT_COLOR,
                    lineContext
                });
            }

            // ==text==
            HighlightConverter.DOUBLE_EQUAL_REGEX.lastIndex = 0;
            while ((match = HighlightConverter.DOUBLE_EQUAL_REGEX.exec(line)) !== null) {
                highlights.push({
                    text: match[1] || '',
                    color: HighlightConverter.DEFAULT_COLOR,
                    lineContext
                });
            }
        }

        this.debug('[高亮转换] 提取到高亮:', highlights.length, '个');
        return highlights;
    }

    /**
     * 剥离所有高亮语法，保留纯文本
     */
    stripHighlightSyntax(markdown: string): string {
        return markdown
            .replace(HighlightConverter.MARK_STYLE_REGEX, '$2')
            .replace(HighlightConverter.MARK_PLAIN_REGEX, '$1')
            .replace(HighlightConverter.DOUBLE_EQUAL_REGEX, '$1');
    }

    // 含文本的块类型
    private static readonly TEXT_BLOCK_TYPES = new Set([
        2, 3, 4, 5, 6, 7, 8, 9, 10, 11, // text, heading1-9
        12, 13, 15, 17                     // bullet, ordered, quote, todo
    ]);

    /**
     * 获取块的文本内容 key（不同 block_type 对应不同 JSON key）
     */
    private static getTextKey(blockType: number): string | null {
        if (blockType === 2) return 'text';
        if (blockType >= 3 && blockType <= 11) return `heading${blockType - 2}`;
        if (blockType === 12) return 'bullet';
        if (blockType === 13) return 'ordered';
        if (blockType === 15) return 'quote';
        if (blockType === 17) return 'todo';
        return null;
    }

    /**
     * 上传后在飞书文档中应用高亮背景色
     */
    async applyHighlightsToDocument(docToken: string, highlights: HighlightInfo[]): Promise<void> {
        if (highlights.length === 0) return;

        this.debug('[高亮转换] 开始应用高亮到文档:', docToken);

        // 获取文档所有块
        const blocks = await this.feishuClient.getDocumentBlocksDetailed(docToken);
        if (!blocks || blocks.length === 0) {
            this.debug('[高亮转换] 无法获取文档块，跳过');
            return;
        }

        // 构建待处理的高亮集合（按 lineContext 分组以加速匹配）
        const remaining = new Set(highlights);

        // 遍历文本块，查找匹配
        for (const block of blocks) {
            if (remaining.size === 0) break;
            if (!HighlightConverter.TEXT_BLOCK_TYPES.has(block.block_type)) continue;

            // 获取块的完整文本
            const blockAny = block as Record<string, any>;
            const textKey = HighlightConverter.getTextKey(block.block_type);
            const textObj = textKey ? blockAny[textKey] : block.text;
            if (!textObj?.elements) continue;

            const fullText = textObj.elements
                .map((el: any) => el.text_run?.content || '')
                .join('');

            // 查找此块中匹配的高亮
            const matchedHighlights: HighlightInfo[] = [];
            for (const h of remaining) {
                if (fullText.includes(h.text)) {
                    matchedHighlights.push(h);
                }
            }

            if (matchedHighlights.length === 0) continue;

            // 构建新的 elements：将文本拆分为普通段和高亮段
            const newElements = this.buildHighlightedElements(fullText, matchedHighlights, textObj.elements);
            if (!newElements) continue;

            // 发送更新请求
            try {
                await this.feishuClient.batchUpdateDocumentBlocks(docToken, [{
                    block_id: block.block_id,
                    update_text_elements: { elements: newElements }
                }]);

                // 标记已处理
                for (const h of matchedHighlights) {
                    remaining.delete(h);
                }

                this.debug('[高亮转换] 已更新块:', block.block_id);
            } catch (error) {
                this.logError('[高亮转换] 更新块失败:', error, { blockId: block.block_id });
            }
        }

        this.debug(`[高亮转换] 完成，剩余未匹配: ${remaining.size}`);
    }

    /**
     * 将文本拆分为带高亮样式的 elements 数组
     * 保留原有 elements 的样式，仅对高亮部分追加 background_color
     */
    private buildHighlightedElements(
        fullText: string,
        highlights: HighlightInfo[],
        originalElements: any[]
    ): any[] | null {
        // 标记高亮区间
        type Span = { start: number; end: number; color: number };
        const spans: Span[] = [];

        for (const h of highlights) {
            let searchFrom = 0;
            while (true) {
                const idx = fullText.indexOf(h.text, searchFrom);
                if (idx === -1) break;
                spans.push({ start: idx, end: idx + h.text.length, color: h.color });
                searchFrom = idx + h.text.length;
                break; // 每个高亮只匹配第一次出现
            }
        }

        if (spans.length === 0) return null;

        // 按位置排序
        spans.sort((a, b) => a.start - b.start);

        // 将原始 elements 展平为带位置的字符级样式映射
        type CharStyle = Record<string, unknown>;
        const charStyles: CharStyle[] = new Array(fullText.length).fill({});
        let pos = 0;
        for (const el of originalElements) {
            if (!el.text_run) continue;
            const content = el.text_run.content || '';
            const style = el.text_run.text_element_style || {};
            for (let i = 0; i < content.length; i++) {
                if (pos + i < charStyles.length) {
                    charStyles[pos + i] = style;
                }
            }
            pos += content.length;
        }

        // 构建新 elements：按高亮区间切分
        const newElements: any[] = [];
        let cursor = 0;

        for (const span of spans) {
            // 前缀（非高亮部分）
            if (cursor < span.start) {
                this.addTextRunSegments(newElements, fullText, cursor, span.start, charStyles, null);
            }
            // 高亮部分
            this.addTextRunSegments(newElements, fullText, span.start, span.end, charStyles, span.color);
            cursor = span.end;
        }

        // 尾部（非高亮部分）
        if (cursor < fullText.length) {
            this.addTextRunSegments(newElements, fullText, cursor, fullText.length, charStyles, null);
        }

        return newElements.length > 0 ? newElements : null;
    }

    /**
     * 添加一段文本的 text_run，保留原有样式，可选追加 background_color
     */
    private addTextRunSegments(
        elements: any[],
        fullText: string,
        start: number,
        end: number,
        charStyles: Record<string, unknown>[],
        highlightColor: number | null
    ): void {
        // 按原有样式变化点切分，避免合并不同样式的文本
        let segStart = start;
        while (segStart < end) {
            const baseStyle = charStyles[segStart] || {};
            let segEnd = segStart + 1;
            while (segEnd < end) {
                const nextStyle = charStyles[segEnd] || {};
                if (JSON.stringify(baseStyle) !== JSON.stringify(nextStyle)) break;
                segEnd++;
            }

            const content = fullText.substring(segStart, segEnd);
            if (content) {
                const style: Record<string, unknown> = { ...baseStyle };
                if (highlightColor !== null) {
                    style['background_color'] = highlightColor;
                }
                elements.push({
                    text_run: {
                        content,
                        text_element_style: style
                    }
                });
            }
            segStart = segEnd;
        }
    }
}
