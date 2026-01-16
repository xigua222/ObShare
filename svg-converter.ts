/**
 * SVG转PNG转换器
 * 专门处理SVG格式图片转换为PNG格式，以便上传到飞书
 */

export interface SvgConverterOptions {
    width?: number;
    height?: number;
    scale?: number;
    backgroundColor?: string;
}

export class SvgConverter {
    private static readonly DEFAULT_WIDTH = 800;
    private static readonly DEFAULT_HEIGHT = 600;
    private static readonly DEFAULT_SCALE = 4; // 4x for better quality

    /**
     * 将SVG内容转换为PNG格式的base64字符串
     * @param svgContent SVG文件内容
     * @param options 转换选项
     * @returns Promise<string> PNG格式的base64字符串
     */
    static async convertSvgToPng(
        svgContent: string, 
        options: SvgConverterOptions = {}
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                // 创建一个临时的canvas元素
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                if (!ctx) {
                    throw new Error('无法创建Canvas上下文');
                }

                // 解析SVG尺寸
                const svgDimensions = this.parseSvgDimensions(svgContent);
                
                // 设置canvas尺寸
                const width = options.width || svgDimensions.width || this.DEFAULT_WIDTH;
                const height = options.height || svgDimensions.height || this.DEFAULT_HEIGHT;
                const scale = options.scale || this.DEFAULT_SCALE;
                
                canvas.width = width * scale;
                canvas.height = height * scale;
                
                // 设置背景色（如果指定）
                if (options.backgroundColor) {
                    ctx.fillStyle = options.backgroundColor;
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                }
                
                // 创建Image对象
                const img = new Image();
                
                img.onload = () => {
                    try {
                        // 获取图片的实际尺寸
                        const imgWidth = img.naturalWidth || img.width;
                        const imgHeight = img.naturalHeight || img.height;
                        
                        // 如果图片有实际尺寸，使用实际尺寸；否则使用解析的尺寸
                        const actualWidth = imgWidth > 0 ? imgWidth : width;
                        const actualHeight = imgHeight > 0 ? imgHeight : height;
                        
                        // 重新设置canvas尺寸以匹配实际比例
                        canvas.width = actualWidth * scale;
                        canvas.height = actualHeight * scale;
                        
                        // 重新设置背景色（如果指定）
                        if (options.backgroundColor) {
                            ctx.fillStyle = options.backgroundColor;
                            ctx.fillRect(0, 0, canvas.width, canvas.height);
                        }
                        
                        // 缩放绘制，保持原始比例
                        ctx.scale(scale, scale);
                        ctx.drawImage(img, 0, 0, actualWidth, actualHeight);
                        
                        // 转换为PNG base64
                        const dataUrl = canvas.toDataURL('image/png', 1.0);
                        const base64Data = dataUrl.split(',')[1];
                        
                        if (base64Data) {
                            resolve(base64Data);
                        } else {
                            reject(new Error('无法生成PNG数据'));
                        }
                    } catch (error) {
                        reject(new Error(`绘制SVG到Canvas失败: ${error instanceof Error ? error.message : String(error)}`));
                    } finally {
                        // 清理资源
                        URL.revokeObjectURL(svgUrl);
                    }
                };
                
                img.onerror = () => {
                    reject(new Error('加载SVG图片失败'));
                    URL.revokeObjectURL(svgUrl);
                };
                
                // 创建SVG的data URL
                const svgBlob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
                const svgUrl = URL.createObjectURL(svgBlob);
                
                img.src = svgUrl;
                
            } catch (error) {
                reject(new Error(`SVG转换初始化失败: ${error instanceof Error ? error.message : String(error)}`));
            }
        });
    }

    /**
     * 解析SVG内容中的尺寸信息
     * @param svgContent SVG内容
     * @returns 尺寸信息
     */
    private static parseSvgDimensions(svgContent: string): { width?: number; height?: number } {
        try {
            // 尝试解析width和height属性，支持带引号和不带引号的值
            const widthMatch = svgContent.match(/width\s*=\s*["']?(\d+(?:\.\d+)?)(?:px|pt|pc|mm|cm|in)?["']?/i);
            const heightMatch = svgContent.match(/height\s*=\s*["']?(\d+(?:\.\d+)?)(?:px|pt|pc|mm|cm|in)?["']?/i);
            
            let width: number | undefined;
            let height: number | undefined;
            
            if (widthMatch && widthMatch[1]) {
                width = parseFloat(widthMatch[1]);
            }
            
            if (heightMatch && heightMatch[1]) {
                height = parseFloat(heightMatch[1]);
            }
            
            // 如果没有找到width/height，尝试解析viewBox
            if (!width || !height) {
                const viewBoxMatch = svgContent.match(/viewBox\s*=\s*["']?([^"']*?)["']?/i);
                if (viewBoxMatch && viewBoxMatch[1]) {
                    const viewBoxValues = viewBoxMatch[1].trim().split(/\s+/);
                    if (viewBoxValues.length >= 4 && viewBoxValues[2] && viewBoxValues[3]) {
                        // viewBox格式: "x y width height"
                        const vbWidth = parseFloat(viewBoxValues[2]);
                        const vbHeight = parseFloat(viewBoxValues[3]);
                        if (!isNaN(vbWidth) && !isNaN(vbHeight)) {
                            width = width || vbWidth;
                            height = height || vbHeight;
                        }
                    }
                }
            }
            
            const result: { width?: number; height?: number } = {};
            if (width !== undefined && width > 0) result.width = width;
            if (height !== undefined && height > 0) result.height = height;
            
            return result;
        } catch (error) {
            // 解析失败时返回空对象，使用默认尺寸
            return {};
        }
    }

    /**
     * 检查文件是否为SVG格式
     * @param fileName 文件名
     * @param content 文件内容（可选）
     * @returns boolean
     */
    static isSvgFile(fileName: string, content?: string): boolean {
        // 检查文件扩展名
        const hasValidExtension = fileName.toLowerCase().endsWith('.svg');
        
        // 如果提供了内容，也检查内容
        if (content) {
            const hasValidContent = content.trim().startsWith('<svg') || content.includes('<svg');
            return hasValidExtension && hasValidContent;
        }
        
        return hasValidExtension;
    }

    /**
     * 生成转换后的PNG文件名
     * @param originalFileName 原始SVG文件名
     * @returns PNG文件名
     */
    static generatePngFileName(originalFileName: string): string {
        const baseName = originalFileName.replace(/\.svg$/i, '');
        return `${baseName}_converted.png`;
    }

    /**
     * 获取推荐的转换选项
     * @param svgContent SVG内容
     * @returns 推荐的转换选项
     */
    static getRecommendedOptions(svgContent: string): SvgConverterOptions {
        const dimensions = this.parseSvgDimensions(svgContent);
        
        // 默认选项
        const defaultOptions = {
            width: 800,
            height: 600,
            scale: 1,
            backgroundColor: 'transparent'
        };
        
        // 如果能解析出尺寸，使用解析的尺寸
        if (dimensions.width && dimensions.height) {
            defaultOptions.width = dimensions.width;
            defaultOptions.height = dimensions.height;
            
            // 根据原始尺寸调整缩放比例
            const maxDimension = Math.max(dimensions.width, dimensions.height);
            
            if (maxDimension <= 100) {
                // 小图标使用8x缩放保持清晰
                defaultOptions.scale = 8;
            } else if (maxDimension <= 200) {
                // 中小图片使用6x缩放
                defaultOptions.scale = 6;
            } else if (maxDimension <= 400) {
                // 中等图片使用4x缩放
                defaultOptions.scale = 4;
            } else if (maxDimension <= 800) {
                // 较大图片使用2x缩放
                defaultOptions.scale = 2;
            } else {
                // 超大图片限制最大尺寸
                const maxSize = 2000;
                if (dimensions.width > maxSize || dimensions.height > maxSize) {
                    const scale = Math.min(maxSize / dimensions.width, maxSize / dimensions.height);
                    defaultOptions.scale = scale;
                } else {
                    defaultOptions.scale = 1;
                }
            }
        }
        
        const result: SvgConverterOptions = {};
        
        // 只设置有明确值的属性
        if (dimensions.width !== undefined) {
            result.width = dimensions.width;
        } else {
            result.width = defaultOptions.width;
        }
        
        if (dimensions.height !== undefined) {
            result.height = dimensions.height;
        } else {
            result.height = defaultOptions.height;
        }
        
        result.scale = defaultOptions.scale;
        result.backgroundColor = defaultOptions.backgroundColor;
        
        return result;
    }
}