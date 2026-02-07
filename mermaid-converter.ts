import { App, MarkdownRenderer, Component } from 'obsidian';

/**
 * Mermaid图表信息接口
 */
export interface MermaidInfo {
    content: string;
    fileName: string;
    type: string;
    pngBase64?: string;
    tempFileName?: string;
}

/**
 * Mermaid转换选项接口
 */
export interface MermaidConverterOptions {
    width?: number;
    height?: number;
    scale?: number;
    theme?: string;
    backgroundColor?: string;
}

/**
 * Mermaid转换结果接口
 */
export interface MermaidConversionResult {
    pngBase64: string;
    originalWidth: number;
    originalHeight: number;
    scale: number;
}

/**
 * Mermaid转换器类 - 基于Obsidian内置渲染的DOM捕获方案
 * 
 * 新方案优势：
 * 1. 完全一致的渲染效果 - 直接使用Obsidian的渲染结果
 * 2. 避免重复渲染 - 不需要重新加载Mermaid库
 * 3. 更高的可靠性 - 减少转换步骤
 * 4. 更好的性能 - 复用已有的渲染结果
 */
export class MermaidConverter {
    private static readonly DEFAULT_SCALE = 2;
    private static readonly DEFAULT_BACKGROUND_COLOR = '#ffffff';
    private static readonly RENDER_TIMEOUT = 10000; // 10秒超时
    private static debugEnabled = false;

    static setDebugEnabled(enabled: boolean): void {
        this.debugEnabled = enabled;
    }

    private static debug(...args: unknown[]): void {
        if (this.debugEnabled) {
            console.debug(...args);
        }
    }

    private static logError(summary: string, error: unknown, details?: Record<string, unknown>): void {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(summary, errorMessage);
        this.debug(`${summary} 详情:`, {
            ...details,
            error,
            errorMessage,
            errorStack: error instanceof Error ? error.stack : undefined
        });
    }

    /**
     * 检查内容是否包含Mermaid图表
     * @param content 文档内容
     * @returns 是否包含Mermaid图表
     */
    static hasMermaidCharts(content: string): boolean {
        const mermaidRegex = /```mermaid\s*\n([\s\S]*?)\n\s*```/g;
        return mermaidRegex.test(content);
    }

    /**
     * 从内容中提取所有Mermaid图表信息
     * @param content 文档内容
     * @returns Mermaid图表信息数组
     */
    static extractMermaidCharts(content: string): MermaidInfo[] {
        const mermaidInfos: MermaidInfo[] = [];
        const mermaidRegex = /```mermaid\s*\n([\s\S]*?)\n\s*```/g;
        let match;
        let index = 0;

        while ((match = mermaidRegex.exec(content)) !== null) {
            const mermaidContent = match[1]?.trim();
            if (mermaidContent) {
                const type = this.detectMermaidType(mermaidContent);
                const fileName = `mermaid-${type}-${Date.now()}-${index}.png`;
                
                mermaidInfos.push({
                    content: mermaidContent,
                    fileName: fileName,
                    type: type
                });
                index++;
            }
        }

        return mermaidInfos;
    }

    /**
     * 检测Mermaid图表类型
     * @param content Mermaid内容
     * @returns 图表类型
     */
    static detectMermaidType(content: string): string {
        const lines = content.split('\n');
        const firstLine = lines.length > 0 && lines[0] ? lines[0].trim().toLowerCase() : '';
        
        if (firstLine.includes('flowchart') || firstLine.includes('graph')) {
            return 'flowchart';
        } else if (firstLine.includes('sequencediagram')) {
            return 'sequence';
        } else if (firstLine.includes('classdiagram')) {
            return 'class';
        } else if (firstLine.includes('statediagram')) {
            return 'state';
        } else if (firstLine.includes('erdiagram')) {
            return 'er';
        } else if (firstLine.includes('gantt')) {
            return 'gantt';
        } else if (firstLine.includes('pie')) {
            return 'pie';
        } else if (firstLine.includes('journey')) {
            return 'journey';
        } else if (firstLine.includes('gitgraph')) {
            return 'gitgraph';
        } else {
            return 'diagram';
        }
    }

    /**
     * 将Mermaid内容转换为PNG格式的base64字符串
     * 使用Obsidian内置渲染，通过DOM捕获SVG元素
     * @param app Obsidian应用实例
     * @param mermaidContent Mermaid图表内容
     * @param options 转换选项
     * @returns Promise<MermaidConversionResult> 包含PNG数据和尺寸信息的结果对象
     */
    static async convertMermaidToPng(
        app: App,
        mermaidContent: string, 
        options: MermaidConverterOptions = {}
    ): Promise<MermaidConversionResult> {
        let tempContainer: HTMLElement | null = null;
        let component: Component | null = null;

        try {
            this.debug('[Mermaid转换] 开始使用Obsidian内置渲染转换Mermaid');

            tempContainer = document.createElement('div');
            tempContainer.classList.add('obshare-mermaid-temp-container');
            document.body.appendChild(tempContainer);

            component = new Component();

            const markdownContent = `\`\`\`mermaid\n${mermaidContent}\n\`\`\``;

            await MarkdownRenderer.render(
                app,
                markdownContent,
                tempContainer,
                '',
                component
            );

            await this.waitForMermaidRender(tempContainer);

            const svgElement = tempContainer.querySelector('svg');
            if (!svgElement) {
                throw new Error('未找到渲染后的SVG元素');
            }

            this.debug('[Mermaid转换] 成功获取SVG元素，开始转换为PNG');

            let svgWidth: number;
            let svgHeight: number;
            
            const widthAttr = svgElement.getAttribute('width');
            const heightAttr = svgElement.getAttribute('height');
            
            if (widthAttr && heightAttr && !widthAttr.includes('%') && !heightAttr.includes('%')) {
                svgWidth = parseFloat(widthAttr);
                svgHeight = parseFloat(heightAttr);
            } else {
                const rect = svgElement.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    svgWidth = rect.width;
                    svgHeight = rect.height;
                } else {
                    try {
                        const bbox = svgElement.getBBox();
                        svgWidth = bbox.width || svgElement.clientWidth || 800;
                        svgHeight = bbox.height || svgElement.clientHeight || 600;
                    } catch (e) {
                        svgWidth = svgElement.clientWidth || 800;
                        svgHeight = svgElement.clientHeight || 600;
                    }
                }
            }

            this.debug(`[SVG转PNG] SVG尺寸: ${svgWidth}x${svgHeight}`);

            const pngBase64 = await this.svgElementToPng(svgElement, options);
            
            const scale = options.scale || this.DEFAULT_SCALE;

            this.debug('[Mermaid转换] 转换完成');
            return {
                pngBase64,
                originalWidth: Math.round(svgWidth),
                originalHeight: Math.round(svgHeight),
                scale
            };

        } catch (error) {
            this.logError('[Mermaid转换] 转换失败:', error);
            throw (error instanceof Error ? error : new Error(String(error)));
        } finally {
            if (component) {
                component.unload();
            }
            if (tempContainer && tempContainer.parentNode) {
                tempContainer.parentNode.removeChild(tempContainer);
            }
        }
    }

    /**
     * 等待Mermaid渲染完成
     * @param container 容器元素
     * @returns Promise<void>
     */
    private static async waitForMermaidRender(container: HTMLElement): Promise<void> {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const checkRender = () => {
                // 检查是否有SVG元素
                const svgElement = container.querySelector('svg');
                if (svgElement) {
                    // 再等待一小段时间确保渲染完全完成
                    setTimeout(() => resolve(), 100);
                    return;
                }

                // 检查超时
                if (Date.now() - startTime > this.RENDER_TIMEOUT) {
                    reject(new Error('Mermaid渲染超时'));
                    return;
                }

                // 继续等待
                setTimeout(checkRender, 50);
            };

            checkRender();
        });
    }

    /**
     * 将SVG元素转换为PNG
     * @param svgElement SVG元素
     * @param options 转换选项
     * @returns Promise<string> PNG的base64字符串
     */
    private static async svgElementToPng(svgElement: SVGSVGElement, options: MermaidConverterOptions): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                // 获取SVG的实际尺寸 - 使用多种方法确保准确性
                let svgWidth: number;
                let svgHeight: number;

                // 方法1：尝试从SVG属性获取
                const widthAttr = svgElement.getAttribute('width');
                const heightAttr = svgElement.getAttribute('height');
                
                if (widthAttr && heightAttr && !widthAttr.includes('%') && !heightAttr.includes('%')) {
                    svgWidth = parseFloat(widthAttr);
                    svgHeight = parseFloat(heightAttr);
                } else {
                    // 方法2：使用getBoundingClientRect获取渲染尺寸
                    const rect = svgElement.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        svgWidth = rect.width;
                        svgHeight = rect.height;
                    } else {
                        // 方法3：使用getBBox获取内容边界
                        try {
                            const bbox = svgElement.getBBox();
                            svgWidth = bbox.width + (bbox.x || 0);
                            svgHeight = bbox.height + (bbox.y || 0);
                        } catch (e) {
                            // 方法4：使用默认尺寸
                            svgWidth = svgElement.clientWidth || 800;
                            svgHeight = svgElement.clientHeight || 600;
                        }
                    }
                }

                // 确保尺寸合理
                svgWidth = Math.max(svgWidth, 100);
                svgHeight = Math.max(svgHeight, 100);

                this.debug(`[SVG转PNG] SVG尺寸: ${svgWidth}x${svgHeight}`);

                // 计算目标尺寸
                const scale = options.scale || this.DEFAULT_SCALE;
                const targetWidth = Math.round(svgWidth * scale);
                const targetHeight = Math.round(svgHeight * scale);

                // 创建Canvas
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                if (!ctx) {
                    reject(new Error('无法创建Canvas上下文'));
                    return;
                }

                canvas.width = targetWidth;
                canvas.height = targetHeight;

                // 设置背景色
                const backgroundColor = options.backgroundColor || this.DEFAULT_BACKGROUND_COLOR;
                ctx.fillStyle = backgroundColor;
                ctx.fillRect(0, 0, targetWidth, targetHeight);

                // 克隆SVG元素以避免修改原始元素
                const clonedNode = svgElement.cloneNode(true);
                if (!(clonedNode instanceof SVGSVGElement)) {
                    reject(new Error('SVG克隆失败'));
                    return;
                }
                const clonedSvg = clonedNode;
                
                // 确保SVG有正确的命名空间和属性
                clonedSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                clonedSvg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
                clonedSvg.setAttribute('width', svgWidth.toString());
                clonedSvg.setAttribute('height', svgHeight.toString());
                clonedSvg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
                
                // 确保所有样式都内联
                this.inlineStyles(clonedSvg);

                // 将SVG转换为数据URL（避免使用Blob URL防止Canvas污染）
                const svgData = new XMLSerializer().serializeToString(clonedSvg);
                // 对SVG数据进行编码，确保特殊字符正确处理
                const encodedSvgData = encodeURIComponent(svgData);
                const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodedSvgData}`;

                // 创建图片并绘制到Canvas
                const img = new Image();
                // 不设置crossOrigin，因为我们使用的是data URL
                
                img.onload = () => {
                    try {
                        // 绘制图片到Canvas
                        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
                        
                        // 转换为PNG base64
                        const pngDataUrl = canvas.toDataURL('image/png', 1.0);
                        const base64Data = pngDataUrl.split(',')[1];
                        
                        if (!base64Data) {
                            reject(new Error('无法生成PNG数据'));
                            return;
                        }
                        
                        this.debug(`[SVG转PNG] 转换完成，最终尺寸: ${targetWidth}x${targetHeight}`);
                        resolve(base64Data);
                    } catch (error) {
                        reject(error instanceof Error ? error : new Error(String(error)));
                    }
                };
                
                img.onerror = () => {
                    reject(new Error('SVG图片加载失败'));
                };
                
                img.src = svgDataUrl;

            } catch (error) {
                this.logError('[SVG转PNG] 转换失败:', error);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    /**
     * 内联SVG样式，确保样式不丢失
     * @param svgElement SVG元素
     */
    private static inlineStyles(svgElement: SVGSVGElement): void {
        try {
            // 获取所有有样式的元素
            const allElements = svgElement.querySelectorAll('*');
            
            allElements.forEach((element) => {
                const computedStyle = window.getComputedStyle(element);
                
                // 复制重要的样式属性
                const importantStyles = [
                    'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap',
                    'font-family', 'font-size', 'font-weight', 'font-style',
                    'text-anchor', 'dominant-baseline', 'alignment-baseline',
                    'opacity', 'visibility', 'display'
                ];
                
                importantStyles.forEach(prop => {
                    const value = computedStyle.getPropertyValue(prop);
                    if (value && value !== 'initial' && value !== 'inherit') {
                        element.setAttribute(prop, value.trim());
                    }
                });
            });
        } catch (error) {
            console.warn('[SVG样式内联] 样式内联失败，继续使用原始样式:', error);
        }
    }

    /**
     * 获取推荐的转换选项
     * @param mermaidContent Mermaid内容
     * @returns 推荐的转换选项
     */
    static getRecommendedOptions(mermaidContent: string): MermaidConverterOptions {
        // 使用适中的缩放比例，确保清晰度和文件大小的平衡
        return {
            scale: this.DEFAULT_SCALE,
            backgroundColor: this.DEFAULT_BACKGROUND_COLOR
        };
    }
}
