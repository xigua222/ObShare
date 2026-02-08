import { App, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, MarkdownRenderer, Component } from 'obsidian';
import { FeishuApiClient, ImageInfo, createFeishuClient } from './feishu-api';
import { CryptoUtils } from './crypto-utils';
import { CalloutConverter, CalloutInfo } from './callout-converter';
import { YamlProcessor, YamlInfo } from './yaml-processor';
import { LinkProcessor, UploadResult } from './link-processor';
import { MermaidConverter, MermaidInfo, MermaidConversionResult } from './mermaid-converter';

// 通知管理器
class NotificationManager {
	private activeNotifications = new Set<string>();
	private notificationTimeouts = new Map<string, NodeJS.Timeout>();

	/**
	 * 显示通知，防止重复
	 * @param message 通知消息
	 * @param duration 显示时长（毫秒）
	 * @param type 通知类型，用于去重
	 */
	showNotice(message: string, duration: number = 4000, type?: string): void {
		const noticeKey = type || message;
		
		// 如果相同类型的通知已存在，则不显示新通知
		if (this.activeNotifications.has(noticeKey)) {
			return;
		}

	
		
		// 标记通知为活跃状态
		this.activeNotifications.add(noticeKey);
		
		// 显示通知
		new Notice(message, duration);
		
		// 设置定时器清除通知状态
		const timeout = setTimeout(() => {
			this.activeNotifications.delete(noticeKey);
			this.notificationTimeouts.delete(noticeKey);
		}, duration);
		
		this.notificationTimeouts.set(noticeKey, timeout);
	}

	/**
	 * 清除所有通知状态
	 */
	clearAll(): void {
		this.notificationTimeouts.forEach(timeout => clearTimeout(timeout));
		this.activeNotifications.clear();
		this.notificationTimeouts.clear();
	}
}

// 上传历史记录接口
interface UploadHistoryItem {
	title: string;
	url: string;
	uploadTime: string; // 格式: YYYY-MM-DD HH:mm
	docToken: string; // 文件的token
	permissions?: {
		isPublic: boolean;
		allowCopy: boolean;
		allowCreateCopy: boolean;
	}; // 权限设置
	referencedDocuments?: Array<{
		title: string;
		docToken: string;
		url: string;
	}>; // 引用文档列表
	isReferencedDocument?: boolean; // 标识是否为引用文档
}

// 插件设置接口
interface FeishuUploaderSettings {
	appId: string;
	appSecret: string;
	folderToken: string;
	userId: string;
	uploadHistory: UploadHistoryItem[];
	uploadCount: number;
	agreedToTerms: boolean; // 用户是否已同意用户协议
	apiCallCount: number; // 本月API调用次数
	lastResetDate: string; // 上次重置日期（YYYY-MM格式）
	enableDoubleLinkMode: boolean; // 是否启用双链模式
	debugLoggingEnabled: boolean; // 是否启用调试日志
}

// 默认设置
const DEFAULT_SETTINGS: FeishuUploaderSettings = {
	appId: '',
	appSecret: '',
	folderToken: '',
	userId: '',
	uploadHistory: [],
	uploadCount: 0,
	agreedToTerms: false,
	apiCallCount: 0,
	lastResetDate: new Date().toISOString().substring(0, 7), // 当前年月
	enableDoubleLinkMode: true, // 默认启用双链模式
	debugLoggingEnabled: false
}

type SensitiveField = keyof Pick<FeishuUploaderSettings, 'appId' | 'appSecret' | 'folderToken' | 'userId'>;

type PermissionSettings = {
	isPublic: boolean;
	allowCopy: boolean;
	allowCreateCopy: boolean;
	allowPrintDownload: boolean;
	copyEntity?: string;
	securityEntity?: string;
};

type RegularImageInfo = {
	fileName: string;
	path: string;
	alt?: string;
	title?: string;
	originalSyntax: 'obsidian' | 'markdown';
};

type CollectedImageInfo =
	| { type: 'regular'; position: number; info: RegularImageInfo; originalMatch: string }
	| { type: 'mermaid'; position: number; info: MermaidInfo; originalMatch: string };

type LinkProcessResult = { processedContent: string; uploadResults: Map<string, UploadResult> };

export default class FeishuUploaderPlugin extends Plugin {
	settings!: FeishuUploaderSettings;
	// 飞书客户端实例
	public feishuClient: FeishuApiClient | null = null;
	// 飞书富文本客户端实例
	public feishuRichClient: FeishuApiClient | null = null;
	// 通知管理器
	public notificationManager = new NotificationManager();
	// 上次保存的敏感数据哈希，用于检测变化
	private lastSensitiveDataHash: string | null = null;

	applyDebugLoggingSetting(): void {
		FeishuApiClient.setDebugEnabled(this.settings.debugLoggingEnabled);
		MermaidConverter.setDebugEnabled(this.settings.debugLoggingEnabled);
		CalloutConverter.setDebugEnabled(this.settings.debugLoggingEnabled);
		YamlProcessor.setDebugEnabled(this.settings.debugLoggingEnabled);
		LinkProcessor.setDebugEnabled(this.settings.debugLoggingEnabled);
		CryptoUtils.setDebugEnabled(this.settings.debugLoggingEnabled);
	}

	override async onload() {
		await this.loadSettings();
		this.applyDebugLoggingSetting();
		
		// 检查用户是否已同意协议
		if (!this.settings.agreedToTerms) {
			const termsModal = new UserAgreementModal(this.app, this);
			termsModal.open();
			return; // 等待用户同意协议后再继续初始化
		}
		
		// 如果用户已同意协议，直接完成初始化
		this.completeInitialization();
	}

	// 完成插件初始化（用户同意协议后调用）
	completeInitialization() {
		// 初始化飞书客户端
		this.initializeFeishuClient();

		// 添加命令：分享当前文档到飞书
		this.addCommand({
			id: 'publish-current-document',
			name: '分享当前文档到飞书',
			callback: () => {
				void this.uploadCurrentDocument();
			}
		});



		// 添加右键菜单
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile && file.extension === 'md') {
					menu.addItem((item) => {
						item
					.setTitle('分享该页面')
					.setIcon('share')
							.onClick(() => {
								void this.uploadFile(file);
							});
					});
				}
			})
		);

		// 添加ribbon按钮
		this.addRibbonIcon('share', '分享当前页面', (evt: MouseEvent) => {
		void this.uploadCurrentDocument();
		});

		// 添加设置选项卡
		this.addSettingTab(new FeishuUploaderSettingTab(this.app, this));
	}
	
	/**
	 * 初始化飞书API客户端
	 */
	private initializeFeishuClient(): void {
		if (this.settings.appId && this.settings.appSecret) {
			// 创建异步回调包装函数
			const asyncCallback = () => {
				void this.incrementApiCallCount().catch(error => {
					const errorMessage = error instanceof Error ? error.message : String(error);
					console.error(`[飞书插件] API调用计数更新失败: ${errorMessage}`);
					if (this.settings.debugLoggingEnabled) {
						console.debug('[飞书插件] API调用计数更新失败详情:', error);
					}
				});
			};
			
			// 如果客户端已存在，更新凭据而不是重新创建
			if (this.feishuClient) {
				this.feishuClient.updateCredentials(this.settings.appId, this.settings.appSecret);
			} else {
				this.feishuClient = createFeishuClient(this.settings.appId, this.settings.appSecret, this.app, asyncCallback);
			}
			
			if (this.feishuRichClient) {
				this.feishuRichClient.updateCredentials(this.settings.appId, this.settings.appSecret);
			} else {
				this.feishuRichClient = createFeishuClient(this.settings.appId, this.settings.appSecret, this.app, asyncCallback);
			}
			
		} else {
			this.feishuClient = null;
			this.feishuRichClient = null;
		}
	}

	override onunload() {
		// 清理通知管理器
		this.notificationManager.clearAll();
		// 清理资源
	}

	async loadSettings() {
		const loadedData = await this.loadData();
		const loadedSettings: Partial<FeishuUploaderSettings> = typeof loadedData === 'object' && loadedData !== null ? loadedData : {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);
		
		// 检查是否有明文敏感数据需要加密
		const sensitiveFields: SensitiveField[] = ['appId', 'appSecret', 'folderToken', 'userId'];
		let hasPlaintextData = false;
		for (const field of sensitiveFields) {
			const value = loadedSettings[field];
			if (value && typeof value === 'string' && !CryptoUtils.isEncryptedData(value)) {
				hasPlaintextData = true;
				break;
			}
		}
		
		// 解密敏感设置数据
		this.settings = await CryptoUtils.decryptSensitiveSettings(this.settings);
		
		// 初始化敏感数据哈希
		const sensitiveData = sensitiveFields.map(field => this.settings[field] || '').join('|');
		this.lastSensitiveDataHash = await this.simpleHash(sensitiveData);
		
		// 如果检测到明文数据，自动加密保存
		if (hasPlaintextData) {
			const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
			await this.saveData(encryptedSettings);
		}
		
		// 向后兼容性处理：为现有历史记录添加默认docToken
		if (this.settings.uploadHistory) {
			this.settings.uploadHistory.forEach(item => {
				if (!item.docToken) {
					item.docToken = '未知';
				}
			});
		}
		

	}

	async saveSettings() {
		// 加密敏感数据后保存
		const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
		await this.saveData(encryptedSettings);
		
		// 保存设置后重新初始化客户端
		this.initializeFeishuClient();
		this.applyDebugLoggingSetting();
		

	}

	/**
	 * 优化的保存方法：只在必要时进行加密
	 */
	private async saveDataOptimized(): Promise<void> {
		// 计算当前敏感数据的哈希
		const sensitiveFields: SensitiveField[] = ['appId', 'appSecret', 'folderToken', 'userId'];
		const sensitiveData = sensitiveFields.map(field => this.settings[field] || '').join('|');
		const currentHash = await this.simpleHash(sensitiveData);
		
		// 如果敏感数据没有变化，直接保存原始数据
		if (this.lastSensitiveDataHash === currentHash) {
			await this.saveData(this.settings);
			return;
		}
		
		// 敏感数据有变化，需要加密
		const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
		await this.saveData(encryptedSettings);
		this.lastSensitiveDataHash = currentHash;
	}

	/**
	 * 简单哈希函数
	 */
	private async simpleHash(data: string): Promise<string> {
		const encoder = new TextEncoder();
		const dataBuffer = encoder.encode(data);
		const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}



	/**
	 * 统一收集文档中所有类型的图片信息（包括普通图片、SVG、Mermaid）
	 * @param content 文档内容
	 * @returns 按原文档位置排序的图片信息数组
	 */
	private collectAllImageInfos(content: string): CollectedImageInfo[] {
		const allImages: CollectedImageInfo[] = [];

		// 1. 收集Mermaid图表信息
		if (MermaidConverter.hasMermaidCharts(content)) {
			const mermaidInfos = MermaidConverter.extractMermaidCharts(content);
			mermaidInfos.forEach(mermaidInfo => {
				const mermaidPattern = new RegExp(`\`\`\`mermaid[\\s\\S]*?\`\`\``, 'g');
				let match;
				
				while ((match = mermaidPattern.exec(content)) !== null) {
					// 检查这个匹配是否对应当前的mermaidInfo
					const matchContent = match[0].replace(/```mermaid\s*\n?/, '').replace(/\n?\s*```$/, '').trim();
					if (matchContent === mermaidInfo.content.trim()) {
						allImages.push({
							type: 'mermaid',
							position: match.index,
							info: mermaidInfo,
							originalMatch: match[0]
						});
						break;
					}
				}
			});
		}

		// 2. 收集普通图片信息（Obsidian语法和标准Markdown语法）
		// Obsidian图片语法: ![[image.png]]
		const obsidianImageRegex = /!\[\[([^\]]+)\]\]/g;
		let match;
		
		while ((match = obsidianImageRegex.exec(content)) !== null) {
			const fileName = match[1];
			if (!fileName) {
				continue;
			}
			const info: RegularImageInfo = {
				fileName,
				path: fileName,
				originalSyntax: 'obsidian'
			};
			allImages.push({
				type: 'regular',
				position: match.index,
				info,
				originalMatch: match[0]
			});
		}

		// 标准Markdown图片语法: ![alt](path)
		const markdownImageRegex = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;
		
		while ((match = markdownImageRegex.exec(content)) !== null) {
			const alt = match[1] ?? '';
			const path = match[2];
			const title = match[3];
			
			if (!path) continue;

			// 对路径进行解码，处理URL编码的字符（如空格变为%20）
			const decodedPath = decodeURI(path);
			const fileName = decodedPath.split('/').pop() || decodedPath;
			
			const info: RegularImageInfo = {
				fileName,
				path: decodedPath,
				alt,
				originalSyntax: 'markdown',
				...(title !== undefined ? { title } : {})
			};
			allImages.push({
				type: 'regular',
				position: match.index,
				info,
				originalMatch: match[0]
			});
		}

		// 3. 按位置排序
		allImages.sort((a, b) => a.position - b.position);

		return allImages;
	}

	/**
	 * 上传当前文档
	 */
	async uploadCurrentDocument(): Promise<void> {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			this.notificationManager.showNotice('请先打开一个Markdown文档', 4000, 'no-markdown-doc');
			return;
		}

		const file = activeView.file;
		if (!file) {
			this.notificationManager.showNotice('无法获取当前文档', 4000, 'no-current-doc');
			return;
		}

		await this.uploadFile(file);
	}

	/**
	 * 转换当前文档中的 Callout 为飞书高亮块
	 */




	/**
	 * 上传指定文件
	 */
	async uploadFile(file: TFile): Promise<void> {
		
		// 根据上传模式选择客户端
		const client = this.feishuClient;
		
		if (!client) {
			console.error('[飞书插件] 上传失败：客户端未初始化');
			this.notificationManager.showNotice('请先在设置中配置飞书应用凭证', 5000, 'missing-credentials');
			return;
		}

		if (!this.settings.folderToken) {
			console.error('[飞书插件] 上传失败：文件夹 token 未配置');
			this.notificationManager.showNotice('请先在设置中配置飞书文件夹 token', 5000, 'missing-folder-token');
			return;
		}

		// 读取文件内容
		let content = await this.app.vault.read(file);
		const title = file.basename;

		// 创建并显示进度条弹窗
		const progressModal = new UploadProgressModal(this.app);
		progressModal.open();

		try {
			// 步骤1: 准备上传 (0-10%)
			progressModal.updateProgress(5, '正在读取文档内容...');

			// 步骤2: 分析文档 (10-15%)
			progressModal.updateProgress(10, '正在分析文档格式...');
			
			// 处理双链引用（在YAML处理之后，其他处理之前）(15-35%)
			let linkProcessor: LinkProcessor | null = null;
			let linkResult: LinkProcessResult | null = null;
			if (this.settings.enableDoubleLinkMode && this.feishuClient) {
				linkProcessor = new LinkProcessor(this.app, this.feishuClient, this);
				linkResult = await linkProcessor.processWikiLinks(content, (status) => {
					// 双链处理占用15%-35%的进度区间，共20%
					const baseProgress = 15;
					const maxProgress = 35;
					
					// 根据状态估算进度
					let currentProgress = baseProgress;
					if (status.includes('正在上传引用的文档')) {
						currentProgress = baseProgress + 5; // 20%
					} else if (status.includes('正在处理引用文档')) {
						// 根据处理进度动态计算
						const match = status.match(/(\d+)\/(\d+)/);
						if (match && match[1] && match[2]) {
							const current = parseInt(match[1]);
							const total = parseInt(match[2]);
							const progressRatio = current / total;
							currentProgress = baseProgress + 5 + (progressRatio * 10); // 20%-30%
						} else {
							currentProgress = baseProgress + 8; // 23%
						}
					} else if (status.includes('正在替换双链为飞书链接')) {
						currentProgress = maxProgress - 2; // 33%
					}
					
					progressModal.updateProgress(Math.min(currentProgress, maxProgress), status);
				});
				content = linkResult.processedContent;
			}
			
			// 检测并缓存YAML frontmatter（必须在移除之前进行）
			let cachedYaml: YamlInfo | null = null;
			if (this.feishuClient) {
				const yamlProcessor = new YamlProcessor(this.feishuClient);
				cachedYaml = yamlProcessor.extractYaml(content);
				if (cachedYaml) {
					// 从内容中移除YAML frontmatter
					content = yamlProcessor.removeYamlFrontmatter(content);
				}
			}
			
			// 统一收集所有图片信息（包括Mermaid、普通图片、SVG）
			progressModal.updateProgress(30, '正在分析文档中的图片...');
			const allImageInfos = this.collectAllImageInfos(content);
			const hasImages = allImageInfos.length > 0;
			
			// 按顺序处理所有图片
			let processedContent = content;
			let cachedMermaidInfos: MermaidInfo[] = [];
			
			if (hasImages) {
				progressModal.updateProgress(35, '正在处理图片...');
				
				try {
					// 按原文档顺序处理每个图片
					for (let i = 0; i < allImageInfos.length; i++) {
						const imageInfo = allImageInfos[i];
						if (!imageInfo) continue;
						
						// 图片处理进度：35% + (当前图片索引 / 总图片数) * 20%
						const progress = 35 + (i / allImageInfos.length) * 20;
						
						if (imageInfo.type === 'mermaid') {
							progressModal.updateProgress(progress, `正在渲染Mermaid图表 ${i + 1}/${allImageInfos.length}...`);
							
							const mermaidInfo = imageInfo.info;
							
							// 获取推荐的转换选项
							const options = MermaidConverter.getRecommendedOptions(mermaidInfo.content);
							
							// 转换Mermaid为PNG
							const conversionResult: MermaidConversionResult = await MermaidConverter.convertMermaidToPng(this.app, mermaidInfo.content, options);
							
							// 创建临时图片文件（在内存中）
							const tempFileName = `temp_${mermaidInfo.fileName}`;
							
							// 将base64数据和实际尺寸信息添加到FeishuApiClient的缓存中
							const svgConvertOptions = {
								originalWidth: conversionResult.originalWidth,
								originalHeight: conversionResult.originalHeight,
								scale: conversionResult.scale
							};
							FeishuApiClient.addMermaidImageToCache(tempFileName, conversionResult.pngBase64, svgConvertOptions);
							FeishuApiClient.addMermaidImageToCache(mermaidInfo.fileName, conversionResult.pngBase64, svgConvertOptions);
							
							// 将Mermaid信息存储起来，在图片处理阶段使用
							mermaidInfo.pngBase64 = conversionResult.pngBase64;
							mermaidInfo.tempFileName = tempFileName;
							
							cachedMermaidInfos.push(mermaidInfo);
							
							// 替换当前Mermaid图表为图片引用
							const imageReference = `![${mermaidInfo.fileName}](${mermaidInfo.fileName})`;
							if (imageInfo.originalMatch) {
								processedContent = processedContent.replace(imageInfo.originalMatch, imageReference);
							}
						}
					}
					
					// 更新content为处理后的内容
					content = processedContent;
					
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					console.error(`[图片处理] 处理图片失败: ${errorMessage}`);
					if (this.settings.debugLoggingEnabled) {
						console.debug('[图片处理] 处理图片失败详情:', error);
					}
					this.notificationManager.showNotice(`图片处理失败: ${errorMessage}`, 6000);
					// 继续处理，不中断上传流程
				}
			}
			
			// 检测并缓存Callout内容
			let cachedCallouts: CalloutInfo[] = [];
			if (this.feishuClient) {
				const calloutConverter = new CalloutConverter(this.feishuClient);
				cachedCallouts = calloutConverter.extractCallouts(content);
			}
			
			// 步骤3: 构建正确顺序的图片信息数组
			let orderedImageInfos: ImageInfo[] = [];
			if (hasImages) {
				// 按照allImageInfos的顺序构建ImageInfo数组
				for (const imageInfo of allImageInfos) {
					if (imageInfo.type === 'mermaid') {
						// Mermaid图片使用生成的文件名
						const mermaidInfo = imageInfo.info;
						orderedImageInfos.push({
							path: mermaidInfo.fileName,
							fileName: mermaidInfo.fileName,
							position: orderedImageInfos.length
						});
					} else {
						// 普通图片
						orderedImageInfos.push({
							path: imageInfo.info.path,
							fileName: imageInfo.info.fileName,
							position: orderedImageInfos.length
						});
					}
				}
			}

			// 步骤4: 正常上传流程 (55-85%)
			progressModal.updateProgress(55, '正在上传文档到飞书...');
			const result = await this.performNormalUpload(file, content, hasImages, orderedImageInfos, progressModal);


			// 步骤4: 处理YAML和Callout (75-90%)
			let processStep = 80;
			
			// 处理YAML frontmatter
			if (cachedYaml) {
				progressModal.updateProgress(processStep, '正在处理文档信息块...');
				await this.autoProcessYaml(result.token, cachedYaml);
				processStep = 85;
			}
			
			// 处理Callout
			if (cachedCallouts.length > 0) {
				progressModal.updateProgress(processStep, '正在处理标注块...');
				// 自动处理 Callout 转换（使用缓存的Callout内容）
				await this.autoConvertCallouts(result.token, cachedCallouts);
				processStep = 90;
			}
			
			// 步骤5: 完成上传 (90-100%)
			progressModal.updateProgress(95, '正在保存上传记录...');
			
			const referencedDocs = this.settings.enableDoubleLinkMode && linkProcessor && linkResult && linkResult.uploadResults.size > 0 ? 
				Array.from(linkResult.uploadResults.values()).map((result) => ({
					title: result.title,
					docToken: result.token,
					url: result.url
				})) : undefined;
			
			await this.addUploadHistory(title, result.url, result.token, undefined, referencedDocs);
			
			if (this.settings.enableDoubleLinkMode && referencedDocs && referencedDocs.length > 0) {
				for (const refDoc of referencedDocs) {
					await this.addUploadHistory(
						refDoc.title, 
						refDoc.url, 
						refDoc.docToken, 
						undefined, 
						undefined, 
						true // 标识为引用文档
					);
				}
			}
			
			// 步骤6: 完成上传
			progressModal.complete();
			
			new DocumentPermissionModal(this.app, result.token, result.url, title, this, false).open();
			
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`[飞书插件] 上传失败: ${errorMessage}`);
			if (this.settings.debugLoggingEnabled) {
				console.debug('[飞书插件] 上传失败详情:', error);
			}
			
			let userMessage = '';
			
			// 根据错误类型提供不同的用户提示
			if (errorMessage.includes('导入任务处理超时')) {
				// 任务处理超时
				userMessage = '文档处理时间较长，请稍后手动检查飞书云文档中的新文档。';
				progressModal.complete(); // 超时也算完成
				new Notice(userMessage, 10000);
				return; // 不显示错误对话框，因为这不是真正的错误
			} else if (errorMessage.includes('网络连接失败')) {
				userMessage = '网络连接失败，请检查以下项目：\n1. 确保网络连接正常\n2. 检查防火墙设置\n3. 尝试重新连接网络后重试';
			} else if (errorMessage.includes('获取访问令牌失败')) {
				userMessage = 'API 认证失败，请检查：\n1. app ID 和 app secret 是否正确\n2. 应用权限是否配置正确\n3. 网络是否能访问飞书 API';
			} else if (errorMessage.includes('文件夹')) {
				userMessage = '文件夹配置错误，请检查：\n1. 文件夹 token 是否正确\n2. 是否有文件夹写入权限';
			} else if (errorMessage.includes('查询导入任务失败，已重试')) {
				userMessage = '查询导入状态失败，已重试2次。文档可能已成功上传，请手动检查飞书云文档。';
			} else {
				userMessage = `上传失败: ${errorMessage}`;
			}
			
			// 显示错误状态
			progressModal.showError(userMessage);
			
			new Notice(userMessage, 8000);
			
			// 如果是网络错误，提供重试选项
			if (errorMessage.includes('网络连接失败')) {
				this.showRetryDialog(file);
			}
		} finally {
			// 清理Mermaid图片缓存
			FeishuApiClient.clearMermaidImageCache();
		}
	}

	/**
	 * 执行正常的文档上传流程
	 * @param file 文件对象
	 * @param content 文档内容
	 * @param hasImages 是否包含图片
	 * @param orderedImageInfos 图片信息数组
	 * @param progressModal 进度模态框
	 * @returns 上传结果
	 */
	private async performNormalUpload(
		file: TFile, 
		content: string, 
		hasImages: boolean, 
		orderedImageInfos: ImageInfo[], 
		progressModal: UploadProgressModal
	): Promise<{ token: string; url: string }> {
		let result: { token: string; url: string };
		
		if (hasImages) {
			// 有图片：使用富文本模式，传递正确顺序的图片信息
			result = await this.feishuRichClient!.uploadDocumentWithImageInfos(
				file.name, // 完整文件名（包含扩展名）用于上传到云空间
				content,
				this.settings.folderToken,
				(status: string) => {
					// 主文档上传占用55%-85%的进度区间，共30%
					let currentProgress = 55;
					if (status.includes('创建导入任务')) {
						currentProgress = 60;
					} else if (status.includes('等待处理') || status.includes('正在处理')) {
						currentProgress = 65;
					} else if (status.includes('处理中') || status.includes('转换')) {
						currentProgress = 75;
					} else if (status.includes('处理图片')) {
						currentProgress = 80;
					} else if (status.includes('完成')) {
						currentProgress = 85;
					}
					progressModal.updateProgress(currentProgress, status);
				},
				orderedImageInfos
			);
		} else {
			// 无图片：使用简单模式
			result = await this.feishuClient!.uploadDocument(
				file.name, // 完整文件名（包含扩展名）用于上传到云空间
				content,
				this.settings.folderToken,
				(status: string) => {
					// 主文档上传占用55%-85%的进度区间，共30%
					let currentProgress = 55;
					if (status.includes('创建导入任务')) {
						currentProgress = 60;
					} else if (status.includes('等待处理') || status.includes('正在处理')) {
						currentProgress = 65;
					} else if (status.includes('处理中') || status.includes('转换')) {
						currentProgress = 75;
					} else if (status.includes('完成')) {
						currentProgress = 85;
					}
					progressModal.updateProgress(currentProgress, status);
				}
			);
		}
		
		return result;
	}

	/**
	 * 自动处理文档中的 YAML frontmatter（无用户交互）
	 * @param docToken 文档Token
	 * @param yamlInfo YAML信息
	 */
	private async autoProcessYaml(docToken: string, yamlInfo: YamlInfo): Promise<void> {
		try {
			if (!this.feishuClient) {
				console.warn('[飞书插件] 飞书客户端未初始化，跳过 YAML 处理');
				return;
			}
			
			const yamlProcessor = new YamlProcessor(this.feishuClient);
			
			// 等待一下确保文档完全同步
			await new Promise(resolve => setTimeout(resolve, 2000));
			
			// 在文档开头插入YAML信息块
			await yamlProcessor.insertYamlBlockInDocument(docToken, yamlInfo, 0);
			
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`[飞书插件] YAML 处理失败: ${errorMessage}`);
			if (this.settings.debugLoggingEnabled) {
				console.debug('[飞书插件] YAML 处理失败详情:', error);
			}
		}
	}

	/**
	 * 自动转换文档中的 Callout（无用户交互）
	 * 在图片处理完成后调用，此时文档已完全同步
	 * @param docToken 文档Token
	 * @param cachedCallouts 预先缓存的Callout数组
	 */
	private async autoConvertCallouts(docToken: string, cachedCallouts: CalloutInfo[]): Promise<void> {
		try {
			if (!this.feishuClient) {
				console.warn('[飞书插件] 飞书客户端未初始化，跳过 Callout 转换');
				return;
			}
			
			if (cachedCallouts.length > 0) {
			const calloutConverter = new CalloutConverter(this.feishuClient);
			
			// 等待一下确保文档完全同步
			await new Promise(resolve => setTimeout(resolve, 1000));
			
			// 获取文档的所有块
			const documentBlocks = await this.feishuClient.getDocumentBlocksDetailed(docToken);
			if (!documentBlocks || documentBlocks.length === 0) {
				console.warn('[飞书插件] 无法获取文档块信息，跳过 Callout 转换');
				return;
			}
			
			// 为文档块添加索引信息
			const blocksWithIndex = calloutConverter.addIndexToBlocks(documentBlocks);
			
			// 查找匹配的引用块
			const matches = calloutConverter.findMatchingQuoteBlocks(blocksWithIndex, cachedCallouts);
			if (matches.length === 0) {
				return;
			}
			
			// 逐个处理 Callout 转换（先插入后删除）
			for (const { callout, block } of matches) {
				await calloutConverter.processSingleCalloutConversion(
					docToken,
					callout,
					block
				);
			}
		}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`[飞书插件] Callout 自动转换出错: ${errorMessage}`);
			if (this.settings.debugLoggingEnabled) {
				console.debug('[飞书插件] Callout 自动转换出错详情:', error);
			}
			// 转换失败不影响主流程，继续执行
		}
	}

	/**
	 * 显示重试对话框
	 */
	private showRetryDialog(file: TFile): void {
		const modal = new RetryModal(this.app, () => {
			// 重试上传
			void this.uploadFile(file);
		});
		modal.open();
	}

	/**
	 * 添加上传历史记录
	 */
	async addUploadHistory(title: string, url: string, docToken: string, permissions?: { isPublic: boolean; allowCopy: boolean; allowCreateCopy: boolean }, referencedDocuments?: Array<{title: string; docToken: string; url: string}>, isReferencedDocument?: boolean): Promise<void> {
		const now = new Date();
		const uploadTime = now.getFullYear() + '-' + 
			String(now.getMonth() + 1).padStart(2, '0') + '-' + 
			String(now.getDate()).padStart(2, '0') + ' ' + 
			String(now.getHours()).padStart(2, '0') + ':' + 
			String(now.getMinutes()).padStart(2, '0');
		
		const historyItem: UploadHistoryItem = {
			title,
			url,
			uploadTime,
			docToken,
			...(permissions && { permissions }),
			...(referencedDocuments && { referencedDocuments }),
			...(isReferencedDocument && { isReferencedDocument })
		};
		
		// 添加到历史记录开头
		this.settings.uploadHistory.unshift(historyItem);
		
		// 增加上传次数
		this.settings.uploadCount++;
		
		// 文档记录永久保存，不进行清理
		
		// 只保存数据，不重新初始化客户端（加密敏感数据）
		const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
		await this.saveData(encryptedSettings);
	}
	
	/**
	 * 更新历史记录中的权限设置
	 */
	async updateHistoryPermissions(docToken: string, permissions: { isPublic: boolean; allowCopy: boolean; allowCreateCopy: boolean }): Promise<void> {
		const historyItem = this.settings.uploadHistory.find(item => item.docToken === docToken);
		if (historyItem) {
			historyItem.permissions = permissions;
			// 只保存数据，不重新初始化客户端（加密敏感数据）
			const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
			await this.saveData(encryptedSettings);
		}
	}

	/**
	 * 更新现有历史记录的时间戳
	 */
	async updateHistoryTimestamp(docToken: string): Promise<void> {
		const historyItem = this.settings.uploadHistory.find(item => item.docToken === docToken);
		if (historyItem) {
			const now = new Date();
			const uploadTime = now.getFullYear() + '-' + 
				String(now.getMonth() + 1).padStart(2, '0') + '-' + 
				String(now.getDate()).padStart(2, '0') + ' ' + 
				String(now.getHours()).padStart(2, '0') + ':' + 
				String(now.getMinutes()).padStart(2, '0');
			
			historyItem.uploadTime = uploadTime;
			
			// 将更新的记录移到历史记录开头
			const index = this.settings.uploadHistory.indexOf(historyItem);
			if (index > 0) {
				this.settings.uploadHistory.splice(index, 1);
				this.settings.uploadHistory.unshift(historyItem);
			}
			
			// 只保存数据，不重新初始化客户端（加密敏感数据）
			const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
			await this.saveData(encryptedSettings);
		}
	}

	/**
	 * 删除单个历史记录项
	 * @param docToken 文档token
	 */
	async deleteHistoryItem(docToken: string): Promise<void> {
		const index = this.settings.uploadHistory.findIndex(item => item.docToken === docToken);
		if (index !== -1) {
			this.settings.uploadHistory.splice(index, 1);
			// 只保存数据，不重新初始化客户端（加密敏感数据）
			const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
			await this.saveData(encryptedSettings);
		}
	}

	/**
	 * 删除文件并清除历史记录
	 * @param docToken 文档token
	 * @param title 文档标题
	 */
	async deleteFileAndHistory(docToken: string, title: string): Promise<void> {
		if (!this.feishuClient) {
			throw new Error('飞书客户端未初始化');
		}

		try {
			// 调用删除文件API
			await this.feishuClient.deleteFile(docToken);
			// 增加API调用计数
			await this.incrementApiCallCount();
			
			// 删除历史记录
			await this.deleteHistoryItem(docToken);
			
			this.notificationManager.showNotice(`文件 "${title}" 已删除`, 3000);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`[飞书插件] 删除文件失败: ${errorMessage}`);
			if (this.settings.debugLoggingEnabled) {
				console.debug('[飞书插件] 删除文件失败详情:', error);
			}
			throw new Error(`删除文件失败: ${errorMessage}`);
		}
	}
	
	/**
	 * 清空上传历史记录
	 */
	async clearUploadHistory(): Promise<void> {
		this.settings.uploadHistory = [];
		// 只保存数据，不重新初始化客户端（加密敏感数据）
		const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
		await this.saveData(encryptedSettings);
		this.notificationManager.showNotice('已清空上传历史记录', 3000, 'history-cleared');
	}

	/**
	 * 重置上传次数
	 */
	async resetUploadCount(): Promise<void> {
		this.settings.uploadCount = 0;
		// 只保存数据，不重新初始化客户端（加密敏感数据）
		const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
		await this.saveData(encryptedSettings);
		this.notificationManager.showNotice('已重置上传次数', 3000, 'count-reset');
	}

	/**
	 * 增加API调用次数
	 */
	async incrementApiCallCount(): Promise<void> {
		// 检查是否需要自动重置（每月1日北京时间）
		await this.checkAndResetApiCount();
		
		this.settings.apiCallCount++;
		// 只保存数据，不重新初始化客户端（加密敏感数据）
		const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
		await this.saveData(encryptedSettings);
		

	}

	/**
	 * 检查并重置API调用次数（每月1日北京时间自动重置）
	 */
	private async checkAndResetApiCount(): Promise<void> {
		const now = new Date();
		// 转换为北京时间（UTC+8）
		const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
		const currentMonth = beijingTime.toISOString().substring(0, 7); // YYYY-MM格式
		
		if (this.settings.lastResetDate !== currentMonth) {
			this.settings.apiCallCount = 0;
			this.settings.lastResetDate = currentMonth;
			// 只保存数据，不重新初始化客户端（加密敏感数据）
			const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
			await this.saveData(encryptedSettings);
		}
	}

	/**
	 * 手动重置API调用次数
	 */
	async resetApiCallCount(): Promise<void> {
		this.settings.apiCallCount = 0;
		const now = new Date();
		const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
		this.settings.lastResetDate = beijingTime.toISOString().substring(0, 7);
		// 只保存数据，不重新初始化客户端（加密敏感数据）
		const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
		await this.saveData(encryptedSettings);
		this.notificationManager.showNotice('已重置API调用次数', 3000, 'api-count-reset');
	}

	/**
	 * 测试网络连接
	 */
	async testNetworkConnection(): Promise<boolean> {
		try {
			if (!this.feishuClient) {
				console.error('[飞书插件] 客户端未初始化，无法测试连接');
				return false;
			}
			
			const result = await this.feishuClient.testConnection();
			// 增加API调用计数
		void this.incrementApiCallCount().catch(error => {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`[飞书插件] API调用计数更新失败: ${errorMessage}`);
			if (this.settings.debugLoggingEnabled) {
				console.debug('[飞书插件] API调用计数更新失败详情:', error);
			}
		});
			return result;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`[飞书插件] 网络连接测试失败: ${errorMessage}`);
			if (this.settings.debugLoggingEnabled) {
				console.debug('[飞书插件] 网络连接测试失败详情:', error);
			}
			return false;
		}
	}

}


// 文档权限设置对话框
class DocumentPermissionModal extends Modal {
	private docToken: string;
	private docUrl: string;
	private title: string;
	private plugin: FeishuUploaderPlugin;
	private isFromSettings: boolean; // 标识是否从设置页面调用
	private allowClose: boolean = false; // 标识是否允许关闭

	constructor(app: App, docToken: string, docUrl: string, title: string, plugin: FeishuUploaderPlugin, isFromSettings: boolean = false) {
		super(app);
		this.docToken = docToken;
		this.docUrl = docUrl;
		this.title = title;
		this.plugin = plugin;
		this.isFromSettings = isFromSettings;
	}

	override onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('obshare-feishu-permission-modal');

		new Setting(contentEl).setName('设置文档权限').setHeading();
		contentEl.createEl('p', { text: `为文档 "${this.title}" 设置访问权限` });

		// 权限选项
		const permissionContainer = contentEl.createDiv('obshare-permission-options');
		
		// 是否公开
		const publicOption = permissionContainer.createDiv('obshare-permission-option');
		const publicCheckbox = publicOption.createEl('input', { type: 'checkbox', cls: 'obshare-permission-checkbox' });
		publicCheckbox.id = 'isPublic';
		const publicLabel = publicOption.createEl('label', { text: '是否公开文档？', attr: { for: 'isPublic' } });
		publicLabel.createEl('div', { text: '若您开启，您需要遵守飞书的相关协议，您作为文档所有者，需对其合法合规性负责，任何由此产生的纠纷与本插件无关。', cls: 'obshare-option-desc' });

		// 是否允许复制
		const copyOption = permissionContainer.createDiv('obshare-permission-option');
		const copyCheckbox = copyOption.createEl('input', { type: 'checkbox', cls: 'obshare-permission-checkbox' });
		copyCheckbox.id = 'allowCopy';
		copyCheckbox.disabled = true; // 默认禁用
		const copyLabel = copyOption.createEl('label', { text: '是否允许复制？', attr: { for: 'allowCopy' } });
		copyLabel.createEl('div', { text: '允许用户复制文档内容', cls: 'obshare-option-desc' });

		// 是否允许创建副本、打印、下载
		const copyCreateOption = permissionContainer.createDiv('obshare-permission-option');
		const copyCreateCheckbox = copyCreateOption.createEl('input', { type: 'checkbox', cls: 'obshare-permission-checkbox' });
		copyCreateCheckbox.id = 'allowCreateCopy';
		copyCreateCheckbox.disabled = true; // 默认禁用
		const copyCreateLabel = copyCreateOption.createEl('label', { text: '是否允许创建副本、打印、下载？', attr: { for: 'allowCreateCopy' } });
		copyCreateLabel.createEl('div', { text: '允许用户创建文档副本、打印和下载文档', cls: 'obshare-option-desc' });

		// 获取当前权限状态
		const currentPermissions = this.getCurrentPermissions();
		if (currentPermissions) {
			publicCheckbox.checked = currentPermissions.isPublic;
			copyCheckbox.checked = currentPermissions.allowCopy;
			copyCreateCheckbox.checked = currentPermissions.allowCreateCopy;
		}

		// 更新选项状态的函数
		const updateOptionStates = () => {
			const isPublic = publicCheckbox.checked;
			
			// 根据公开状态启用/禁用后两个选项
			copyCheckbox.disabled = !isPublic;
			copyCreateCheckbox.disabled = !isPublic;
			
			// 如果公开被取消，清除后两个选项的选中状态
			if (!isPublic) {
				copyCheckbox.checked = false;
				copyCreateCheckbox.checked = false;
			}
			
			// 更新选项容器的视觉状态
			if (isPublic) {
				copyOption.removeClass('obshare-permission-option-disabled');
				copyOption.addClass('obshare-permission-option-enabled');
				copyCreateOption.removeClass('obshare-permission-option-disabled');
				copyCreateOption.addClass('obshare-permission-option-enabled');
			} else {
				copyOption.removeClass('obshare-permission-option-enabled');
				copyOption.addClass('obshare-permission-option-disabled');
				copyCreateOption.removeClass('obshare-permission-option-enabled');
				copyCreateOption.addClass('obshare-permission-option-disabled');
			}
		};

		// 整个区域点击事件
		publicOption.onclick = () => {
			publicCheckbox.checked = !publicCheckbox.checked;
			updateOptionStates();
		};

		copyOption.onclick = () => {
			if (!copyCheckbox.disabled) {
				copyCheckbox.checked = !copyCheckbox.checked;
			}
		};

		copyCreateOption.onclick = () => {
			if (!copyCreateCheckbox.disabled) {
				copyCreateCheckbox.checked = !copyCreateCheckbox.checked;
			}
		};

		// 阻止复选框点击事件冒泡，避免双重触发
		publicCheckbox.onclick = (e) => {
			e.stopPropagation();
			updateOptionStates();
		};

		copyCheckbox.onclick = (e) => {
			e.stopPropagation();
		};

		copyCreateCheckbox.onclick = (e) => {
			e.stopPropagation();
		};

		// 初始化状态
		updateOptionStates();

		// 按钮容器
		const buttonContainer = contentEl.createDiv('obshare-modal-button-container');
		
		const submitButton = buttonContainer.createEl('button', { text: '提交设置', cls: 'mod-cta' });
		submitButton.onclick = () => {
			void (async () => {
			// 收集用户选择
			const isPublic = publicCheckbox.checked;
			const allowCopy = copyCheckbox.checked;
			const allowCreateCopy = copyCreateCheckbox.checked;
			
			const permissions = {
				isPublic: isPublic,
				allowCopy: allowCopy,
				allowCreateCopy: allowCreateCopy,
				allowPrintDownload: allowCreateCopy,
				// 新增参数：根据用户选择设置特殊权限
				copyEntity: allowCopy ? 'anyone_can_view' : 'only_full_access',
				securityEntity: allowCreateCopy ? 'anyone_can_view' : 'only_full_access'
			};

			// 禁用按钮防止重复提交
			submitButton.disabled = true;
			submitButton.textContent = '设置中...';

			try {
				// 检查用户ID是否已配置
				if (!this.plugin.settings.userId) {
					throw new Error('请先在设置中配置您的飞书用户 ID');
				}
				
				// 根据调用来源选择不同的API方法
				if (this.isFromSettings) {
					// 从设置页面调用：仅更新权限，不转移所有权
					await this.plugin.feishuClient!.updateDocumentPermissionsOnly(this.docToken, permissions);
				} else {
					// 从上传流程调用：设置权限并转移所有权
					await this.plugin.feishuClient!.setDocumentPermissions(this.docToken, permissions, this.plugin.settings.userId);
					
					// 为引用文档设置相同的权限
					await this.applyPermissionsToReferencedDocuments(permissions, this.plugin.settings.userId);
				}
				
				// 保存权限设置到历史记录
				const permissionsToSave = {
					isPublic: isPublic,
					allowCopy: allowCopy,
					allowCreateCopy: allowCreateCopy
				};
				
				// 关闭权限设置弹窗
				this.forceClose();
				
				if (!this.isFromSettings) {
				// 从上传流程调用时更新历史记录中的权限设置
					await this.plugin.updateHistoryPermissions(this.docToken, permissionsToSave);
				
				new UploadResultModal(this.app, this.docUrl, this.title).open();
			} else {
				// 从设置页面调用时更新历史记录中的权限设置
					await this.plugin.updateHistoryPermissions(this.docToken, permissionsToSave);
				this.plugin.notificationManager.showNotice('文档权限设置成功', 3000);
			}
				
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				console.error(`[飞书插件] 权限设置失败: ${errorMessage}`);
				if (this.plugin.settings.debugLoggingEnabled) {
					console.debug('[飞书插件] 权限设置失败详情:', error);
				}
				this.plugin.notificationManager.showNotice(`权限设置失败: ${errorMessage}`, 5000, 'permission-error');
				
				// 恢复按钮状态
				submitButton.disabled = false;
				submitButton.textContent = '提交设置';
			}
			})();
		};
	}

	override onClose() {
		// 如果是从设置页面调用，或者已经允许关闭，则正常关闭
		if (this.isFromSettings || this.allowClose) {
			const { contentEl } = this;
			contentEl.empty();
			super.onClose();
		}
		// 如果是从上传流程调用且未允许关闭，阻止弹窗关闭
	}

	// 获取当前权限设置
	getCurrentPermissions(): { isPublic: boolean; allowCopy: boolean; allowCreateCopy: boolean } | null {
		const historyItem = this.plugin.settings.uploadHistory.find(item => item.docToken === this.docToken);
		return historyItem?.permissions || null;
	}

	// 添加强制关闭方法，仅在权限设置成功后调用
	forceClose() {
		this.allowClose = true;
		this.close();
	}

	/**
	 * 为引用文档设置相同的权限
	 */
	private async applyPermissionsToReferencedDocuments(permissions: PermissionSettings, userId: string): Promise<void> {
		try {
			// 获取当前文档的历史记录
			const history = this.plugin.settings.uploadHistory.find(h => h.docToken === this.docToken);
			
			if (!history) {
				return;
			}
			
			if (!history.referencedDocuments) {
				return;
			}
			
			if (history.referencedDocuments.length === 0) {
				return;
			}

			// 为每个引用文档设置权限
			for (const refDoc of history.referencedDocuments) {
				try {
					// 使用与主文档完全相同的权限设置方法
					await this.plugin.feishuClient!.setDocumentPermissions(refDoc.docToken, permissions, userId);
					
					// 更新引用文档的历史记录权限
					await this.plugin.updateHistoryPermissions(refDoc.docToken, {
						isPublic: permissions.isPublic,
						allowCopy: permissions.allowCopy,
						allowCreateCopy: permissions.allowCreateCopy
					});
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					console.error(`[飞书插件] 引用文档权限设置失败: ${refDoc.title}: ${errorMessage}`);
					if (this.plugin.settings.debugLoggingEnabled) {
						console.debug(`[飞书插件] 引用文档权限设置失败详情: ${refDoc.title}`, error);
					}
					// 继续处理其他引用文档，不中断整个流程
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`[飞书插件] 引用文档权限设置过程出错: ${errorMessage}`);
			if (this.plugin.settings.debugLoggingEnabled) {
				console.debug('[飞书插件] 引用文档权限设置过程出错详情:', error);
			}
			// 不抛出错误，避免影响主文档的权限设置流程
		}
	}

	/**
	 * 检测并转换 Callout
	 */

}

// 上传结果对话框
class UploadResultModal extends Modal {
	private url: string;
	private title: string;

	constructor(app: App, url: string, title: string) {
		super(app);
		this.url = url;
		this.title = title;
	}

	override onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('obshare-feishu-success-modal');

		const successTitle = '上传成功！';
		const successMessage = `文档 "${this.title}" 已成功上传到飞书云文档`;

		new Setting(contentEl).setName(successTitle).setHeading();
		contentEl.createEl('p', { text: successMessage });

		const linkEl = contentEl.createEl('a', {
			text: this.url,
			href: this.url
		});
		linkEl.setAttribute('target', '_blank');

		const buttonContainer = contentEl.createDiv('obshare-modal-button-container');
		
		const copyButton = buttonContainer.createEl('button', { text: '复制链接' });
		copyButton.onclick = () => {
			void navigator.clipboard.writeText(this.url).then(() => {
				new Notice('链接已复制到剪贴板');
			}).catch(() => {
				new Notice('复制失败，请手动复制链接');
			});
		};

		const openButton = buttonContainer.createEl('button', { text: '打开文档' });
		openButton.onclick = () => {
			window.open(this.url, '_blank');
		};

		const closeButton = buttonContainer.createEl('button', { text: '关闭' });
		closeButton.onclick = () => {
			this.close();
		};
	}

	override onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class RetryModal extends Modal {
	private onRetry: () => void;

	constructor(app: App, onRetry: () => void) {
		super(app);
		this.onRetry = onRetry;
	}

	override onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		// 标题
		new Setting(contentEl).setName('网络连接失败').setHeading();

		// 说明文字
		const descEl = contentEl.createEl('div', { cls: 'retry-modal-desc' });
		descEl.createEl('p', { text: '上传失败，可能是网络连接问题。' });
		descEl.createEl('p', { text: '请检查网络连接后重试，或稍后再试。' });

		// 按钮容器
		const buttonContainer = contentEl.createEl('div', { cls: 'obshare-retry-modal-buttons' });

		// 取消按钮
		const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
		cancelBtn.onclick = () => {
			this.close();
		};

		// 重试按钮
		const retryBtn = buttonContainer.createEl('button', { text: '重试', cls: 'mod-cta' });
		retryBtn.onclick = () => {
			this.close();
			this.onRetry();
		};
	}

	override onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class FeishuUploaderSettingTab extends PluginSettingTab {
	plugin: FeishuUploaderPlugin;

	constructor(app: App, plugin: FeishuUploaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * 按页面聚合上传历史记录
	 * @param uploadHistory 上传历史记录数组
	 * @returns 按页面标题聚合的Map
	 */
	private groupUploadHistoryByPage(uploadHistory: UploadHistoryItem[]): Map<string, {
		uploads: UploadHistoryItem[];
		isReferencedDocument: boolean;
	}> {
		const groupedMap = new Map<string, {
			uploads: UploadHistoryItem[];
			isReferencedDocument: boolean;
		}>();

		// 按页面标题分组
		uploadHistory.forEach(item => {
			const pageTitle = item.title;
			
			if (!groupedMap.has(pageTitle)) {
				groupedMap.set(pageTitle, {
					uploads: [],
					isReferencedDocument: item.isReferencedDocument || false
				});
			}
			
			groupedMap.get(pageTitle)!.uploads.push(item);
		});

		// 对每个组内的上传记录按时间倒序排序（最新的在前）
		groupedMap.forEach(group => {
			group.uploads.sort((a, b) => {
				// 将时间字符串转换为Date对象进行比较
				const timeA = new Date(a.uploadTime.replace(' ', 'T'));
				const timeB = new Date(b.uploadTime.replace(' ', 'T'));
				return timeB.getTime() - timeA.getTime(); // 倒序：最新的在前
			});
		});

		// 将Map按照最新上传时间排序（最近上传的页面在前）
		const sortedEntries = Array.from(groupedMap.entries()).sort((a, b) => {
			const uploadsA = a[1].uploads;
			const uploadsB = b[1].uploads;
			if (uploadsA.length === 0 || uploadsB.length === 0) {
				return uploadsB.length - uploadsA.length; // 有上传记录的排在前面
			}
			const firstUploadA = uploadsA[0];
			const firstUploadB = uploadsB[0];
			if (!firstUploadA || !firstUploadB) {
				return 0; // 如果任一为空，保持原顺序
			}
			const latestTimeA = new Date(firstUploadA.uploadTime.replace(' ', 'T'));
			const latestTimeB = new Date(firstUploadB.uploadTime.replace(' ', 'T'));
			return latestTimeB.getTime() - latestTimeA.getTime();
		});

		return new Map(sortedEntries);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// 添加GitHub链接和Star请求
		const headerContainer = containerEl.createDiv({ cls: 'obshare-header-container' });
		const headerSetting = new Setting(headerContainer)
			.setName('基础设置')
			.setHeading();
		headerSetting.nameEl.empty();
		const titleRow = headerSetting.nameEl.createDiv({ cls: 'obshare-title-row' });
		titleRow.createSpan({ text: '基础设置', cls: 'obshare-settings-title' });

		const githubLink = titleRow.createEl('a', {
			href: 'https://github.com/xigua222/ObShare',
			cls: 'obshare-github-link'
		});
		githubLink.setAttribute('target', '_blank');

		const iconSpan = githubLink.createSpan({ cls: 'obshare-github-link-icon' });
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', '16');
		svg.setAttribute('height', '16');
		svg.setAttribute('viewBox', '0 0 48 48');
		svg.setAttribute('fill', 'none');
		const pathOuter = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		pathOuter.setAttribute('fill-rule', 'evenodd');
		pathOuter.setAttribute('clip-rule', 'evenodd');
		pathOuter.setAttribute('d', 'M24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4ZM0 24C0 10.7452 10.7452 0 24 0C37.2548 0 48 10.7452 48 24C48 37.2548 37.2548 48 24 48C10.7452 48 0 37.2548 0 24Z');
		pathOuter.setAttribute('fill', 'currentColor');
		const pathInner = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		pathInner.setAttribute('fill-rule', 'evenodd');
		pathInner.setAttribute('clip-rule', 'evenodd');
		pathInner.setAttribute('d', 'M19.1833 45.4716C18.9898 45.2219 18.9898 42.9973 19.1833 38.798C17.1114 38.8696 15.8024 38.7258 15.2563 38.3667C14.437 37.828 13.6169 36.1667 12.8891 34.9959C12.1614 33.8251 10.5463 33.64 9.89405 33.3783C9.24182 33.1165 9.07809 32.0496 11.6913 32.8565C14.3044 33.6634 14.4319 35.8607 15.2563 36.3745C16.0806 36.8883 18.0515 36.6635 18.9448 36.2519C19.8382 35.8403 19.7724 34.3078 19.9317 33.7007C20.1331 33.134 19.4233 33.0083 19.4077 33.0037C18.5355 33.0037 13.9539 32.0073 12.6955 27.5706C11.437 23.134 13.0581 20.2341 13.9229 18.9875C14.4995 18.1564 14.4485 16.3852 13.7699 13.6737C16.2335 13.3589 18.1347 14.1343 19.4734 16.0001C19.4747 16.0108 21.2285 14.9572 24.0003 14.9572C26.772 14.9572 27.7553 15.8154 28.5142 16.0001C29.2731 16.1848 29.88 12.7341 34.5668 13.6737C33.5883 15.5969 32.7689 18.0001 33.3943 18.9875C34.0198 19.9749 36.4745 23.1147 34.9666 27.5706C33.9614 30.5413 31.9853 32.3523 29.0384 33.0037C28.7005 33.1115 28.5315 33.2855 28.5315 33.5255C28.5315 33.8856 28.9884 33.9249 29.6465 35.6117C30.0853 36.7362 30.117 39.948 29.7416 45.247C28.7906 45.4891 28.0508 45.6516 27.5221 45.7347C26.5847 45.882 25.5669 45.9646 24.5669 45.9965C23.5669 46.0284 23.2196 46.0248 21.837 45.8961C20.9154 45.8103 20.0308 45.6688 19.1833 45.4716Z');
		pathInner.setAttribute('fill', 'currentColor');
		svg.appendChild(pathOuter);
		svg.appendChild(pathInner);
		iconSpan.appendChild(svg);

		githubLink.createSpan({ text: 'Star on GitHub' });

		// 鼓励文案
		headerContainer.createEl('div', {
			text: '插件完全免费开源，如果您喜欢这个插件，恳请帮忙点个 star，这会是对作者极大的鼓励~',
			cls: 'obshare-encourage-text'
		});

		// 说明文档
		const descEl = containerEl.createDiv();
		descEl.createEl('p', { text: '你需要配置飞书应用 app ID、app secret、您的飞书用户 ID、您的文件夹 token 才能正常启动此插件' });
		const docLinkP = descEl.createEl('p');
		docLinkP.createSpan({ text: '完成配置预计需要5-10分钟，请参阅：' });
		const docLink = docLinkP.createEl('a', { 
			text: '快速配置您的 obshare',
			href: 'https://itlueqqx8t.feishu.cn/docx/XUJmdxbf7octOFx3Vt0c3KJ3nWe'
		});
		docLink.setAttribute('target', '_blank');

		// App ID设置
		const appIdSetting = new Setting(containerEl)
			.setName('App ID')
			.setDesc('飞书应用的 app ID')
			.addText(text => text
				.setPlaceholder('输入 app ID')
				.setValue(this.plugin.settings.appId)
				.onChange((value) => {
					this.plugin.settings.appId = value;
					void this.plugin.saveSettings();
				}));
		appIdSetting.nameEl.empty();
		appIdSetting.nameEl.createSpan({ text: 'App ID ' });
		appIdSetting.nameEl.createSpan({ text: '*', cls: 'obshare-required-field' });

		// App Secret设置
		const appSecretSetting = new Setting(containerEl)
			.setName('App secret')
			.setDesc('飞书应用的 app secret')
			.addText(text => text
				.setPlaceholder('输入 app secret')
				.setValue(this.plugin.settings.appSecret)
				.onChange((value) => {
					this.plugin.settings.appSecret = value;
					void this.plugin.saveSettings();
				}));
		appSecretSetting.nameEl.empty();
		appSecretSetting.nameEl.createSpan({ text: 'App secret ' });
		appSecretSetting.nameEl.createSpan({ text: '*', cls: 'obshare-required-field' });

		// 用户ID设置
		const userIdSetting = new Setting(containerEl)
			.setName('用户 ID')
			.setDesc('您的飞书用户 ID')
			.addText(text => text
				.setPlaceholder('输入您的飞书用户 ID')
				.setValue(this.plugin.settings.userId)
				.onChange((value) => {
					this.plugin.settings.userId = value;
					void this.plugin.saveSettings();
				}));
		userIdSetting.nameEl.empty();
		userIdSetting.nameEl.createSpan({ text: '用户 ID ' });
		userIdSetting.nameEl.createSpan({ text: '*', cls: 'obshare-required-field' });

		// 文件夹Token设置
		const folderTokenSetting = new Setting(containerEl)
			.setName('文件夹 token')
			.setDesc('飞书云空间文件夹的 token，文档将上传到此文件夹')
			.addText(text => text
				.setPlaceholder('输入文件夹 token')
				.setValue(this.plugin.settings.folderToken)
				.onChange((value) => {
					this.plugin.settings.folderToken = value;
					void this.plugin.saveSettings();
				}));
		folderTokenSetting.nameEl.empty();
		folderTokenSetting.nameEl.createSpan({ text: '文件夹 token ' });
		folderTokenSetting.nameEl.createSpan({ text: '*', cls: 'obshare-required-field' });

		// 双链模式设置
		new Setting(containerEl).setName('上传设置').setHeading();
		
		new Setting(containerEl)
			.setName('双链模式')
			.setDesc('双链模式可以自动帮你上传文档内所有[[]]引用的文档，自动建立链接，使得您的分享更加便捷完整，但在引用文档数量多的情况下，可能使上传速度变慢，需要等待更久。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableDoubleLinkMode)
				.onChange((value) => {
					this.plugin.settings.enableDoubleLinkMode = value;
					void this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('调试日志')
			.setDesc('启用后会在开发者控制台输出调试信息，用于排查问题。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugLoggingEnabled)
				.onChange((value) => {
					this.plugin.settings.debugLoggingEnabled = value;
					this.plugin.applyDebugLoggingSetting();
					void this.plugin.saveSettings();
				}));

		// 测试连接按钮
		new Setting(containerEl)
			.setName('测试连接')
			.setDesc('测试飞书 API 连接是否正常')
			.addButton(button => button
				.setButtonText('测试连接')
				.onClick(() => {
					void (async () => {
						if (!this.plugin.feishuClient) {
							this.plugin.notificationManager.showNotice('请先配置 app ID 和 app secret', 4000, 'missing-config');
							return;
						}
						
						try {
							button.setButtonText('测试中...');
							const success = await this.plugin.testNetworkConnection();
							if (success) {
								this.plugin.notificationManager.showNotice('网络连接测试成功！', 3000, 'test-success');
							} else {
								new Notice('网络连接测试失败，请检查网络和配置');
							}
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error);
							if (errorMessage.includes('网络连接失败')) {
								new Notice('网络连接失败，请检查网络连接后重试');
							} else {
								new Notice(`连接测试失败: ${errorMessage}`);
							}
						} finally {
							button.setButtonText('测试连接');
						}
					})();
				}));

		// 数据统计
		new Setting(containerEl).setName('数据统计').setHeading();
		
		// 显示分享文档数
		new Setting(containerEl)
			.setName('分享文档数')
			.setDesc(`您已成功分享 ${this.plugin.settings.uploadCount} 个文档`)
			.addButton(button => button
				.setButtonText('重置计数')
				.setWarning()
				.onClick(() => {
				void (async () => {
					await this.plugin.resetUploadCount();
					this.display();
				})();
				}));

		// 显示本月API调用次数
		const currentMonth = new Date().toISOString().substring(0, 7);
		const isCurrentMonth = this.plugin.settings.lastResetDate === currentMonth;
		const displayCount = isCurrentMonth ? this.plugin.settings.apiCallCount : 0;
		new Setting(containerEl)
			.setName('本月 API 调用次数')
			.setDesc(`本月已调用飞书 API ${displayCount} 次`)
			.addButton(button => button
				.setButtonText('重置计数')
				.setWarning()
				.onClick(() => {
				void (async () => {
					await this.plugin.resetApiCallCount();
					this.display();
				})();
				}));

		// 发布管理
		new Setting(containerEl).setName('分享管理').setHeading();
		
		if (this.plugin.settings.uploadHistory.length === 0) {
			containerEl.createEl('p', { text: '暂无上传记录', cls: 'obshare-upload-history-empty' });
		} else {
			// 清空历史记录按钮
			new Setting(containerEl)
				.setName('清空历史记录')
				.setDesc('分享历史记录')
				.addButton(button => button
					.setButtonText('清空')
					.setWarning()
					.onClick(() => {
						void (async () => {
							await this.plugin.clearUploadHistory();
							this.display();
						})();
					}));
			
			// 按页面聚合上传记录
			const groupedHistory = this.groupUploadHistoryByPage(this.plugin.settings.uploadHistory);
			
			// 历史记录列表
			const historyContainer = containerEl.createDiv('obshare-upload-history-container');
			
			// 遍历每个页面组
			groupedHistory.forEach((pageGroup, pageTitle) => {
				// 页面组容器
				const pageGroupContainer = historyContainer.createDiv('obshare-page-group-container');
				
				// 页面组标题
				const pageGroupHeader = pageGroupContainer.createDiv('obshare-page-group-header');
				const groupTitleText = pageGroup.isReferencedDocument ? `🔗 ${pageTitle}` : pageTitle;
				pageGroupHeader.createEl('div', {
					text: groupTitleText,
					cls: 'obshare-page-group-title'
				});
				
				// 显示该页面的上传次数
				pageGroupHeader.createEl('div', {
					text: `${pageGroup.uploads.length} 次上传`,
					cls: 'obshare-page-group-count'
				});
				
				// 上传记录列表（按时间倒序）
				const uploadsContainer = pageGroupContainer.createDiv('obshare-page-uploads-container');
				
				pageGroup.uploads.forEach((item, index) => {
					const historyItem = uploadsContainer.createDiv('obshare-upload-history-item');
					
					// 如果是最新的上传，添加特殊样式
					if (index === 0) {
						historyItem.addClass('obshare-upload-history-item-latest');
					}
					
					// 标题和时间在同一行
					const headerEl = historyItem.createDiv('obshare-upload-history-header');
					
					// 上传时间和NEW标签
					const timeContainer = headerEl.createDiv('obshare-upload-time-container');
					timeContainer.createEl('div', { 
						text: item.uploadTime, 
						cls: 'obshare-upload-history-time' 
					});
					
					// 为最新上传添加NEW标签
					if (index === 0) {
						timeContainer.createEl('span', {
							text: 'New',
							cls: 'obshare-upload-new-tag'
						});
					}
					
					// 链接和操作图标在同一行
					const linkRowEl = historyItem.createDiv('obshare-upload-history-link-row');
					
					// 链接
					const linkEl = linkRowEl.createEl('a', { 
						text: item.url, 
						href: item.url,
						cls: 'obshare-upload-history-link'
					});
					linkEl.setAttribute('target', '_blank');
					
					// 复制图标
					const copyIcon = linkRowEl.createEl('span', { 
						text: '📋',
						cls: 'obshare-upload-history-copy-icon'
					});
					copyIcon.onclick = () => {
						void navigator.clipboard.writeText(item.url).then(() => {
							new Notice('链接已复制到剪贴板');
						}).catch(() => {
							new Notice('复制失败，请手动复制链接');
						});
					};
					
					// 权限管理图标
					const permissionIcon = linkRowEl.createEl('span', {
						text: '设置',
						cls: 'obshare-upload-history-copy-icon'
					});
					permissionIcon.onclick = () => {
						// 打开权限管理弹窗（从设置页面调用）
						const permissionModal = new DocumentPermissionModal(
							this.app,
							item.docToken,
							item.url,
							item.title,
							this.plugin,
							true // isFromSettings = true
						);
						permissionModal.open();
					};

					// 删除图标
					const deleteIcon = linkRowEl.createEl('span', {
						text: '删除',
						cls: 'obshare-upload-history-copy-icon'
					});
					deleteIcon.onclick = () => {
						const modal = new DeleteConfirmationModal(
							this.app,
							`确定要删除文件 "${item.title}" 吗？\n\n注意：此操作将删除飞书云文档中的文件！`,
							async () => {
								await this.plugin.deleteHistoryItem(item.docToken);
								this.display();

								try {
									if (this.plugin.feishuClient) {
										await this.plugin.feishuClient.deleteFile(item.docToken);
										await this.plugin.incrementApiCallCount();
									}
								} catch (error) {
									const errorMessage = error instanceof Error ? error.message : String(error);
									console.error(`[设置页面] API删除文件失败: ${errorMessage}`);
									if (this.plugin.settings.debugLoggingEnabled) {
										console.debug('[设置页面] API删除文件失败详情:', error);
									}
									if (error instanceof Error && (error.message.includes('404') || error.message.includes('not found'))) {
										this.plugin.notificationManager.showNotice(
											'删除失败，请您在飞书云文档中自行尝试删除。',
											5000
										);
									} else {
										this.plugin.notificationManager.showNotice(
											'删除失败，请您在飞书云文档中自行尝试删除。',
											5000
										);
									}
								}
							}
						);
						modal.open();
					};
				});
			});
		}
	}
}

class DeleteConfirmationModal extends Modal {
	private message: string;
	private onConfirm: () => void | Promise<void>;

	constructor(app: App, message: string, onConfirm: () => void | Promise<void>) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	override onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		new Setting(contentEl).setName('确认删除').setHeading();
		contentEl.createEl('p', { text: this.message });

		const buttonContainer = contentEl.createDiv('obshare-modal-button-container');
		const confirmButton = buttonContainer.createEl('button', { text: '确认删除', cls: 'mod-warning' });
		const cancelButton = buttonContainer.createEl('button', { text: '取消' });

		cancelButton.onclick = () => {
			this.close();
		};

		confirmButton.onclick = () => {
			void Promise.resolve(this.onConfirm()).finally(() => {
				this.close();
			});
		};
	}

	override onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// 用户协议弹窗
class CalloutConversionModal extends Modal {
	private callouts: Array<{type: string, content: string}>;
	private onConfirm: (selectedCallouts: number[]) => void;
	private selectedCallouts: Set<number> = new Set();

	constructor(
		app: App, 
		callouts: Array<{type: string, content: string}>, 
		onConfirm: (selectedCallouts: number[]) => void
	) {
		super(app);
		this.callouts = callouts;
		this.onConfirm = onConfirm;
		// 默认选择所有 Callout
		this.callouts.forEach((_, index) => {
			this.selectedCallouts.add(index);
		});
	}

	override onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		new Setting(contentEl).setName('Callout 转换确认').setHeading();
		contentEl.createEl('p', { 
			text: `发现 ${this.callouts.length} 个 callout 块，请选择要转换为飞书高亮块的项目：` 
		});

		// 创建 Callout 列表
		const listContainer = contentEl.createDiv({ cls: 'obshare-callout-list' });
		
		this.callouts.forEach((callout, index) => {
			const itemDiv = listContainer.createDiv({ cls: 'obshare-callout-item' });
			
			// 创建复选框
			const checkbox = itemDiv.createEl('input', {
				type: 'checkbox',
				attr: { id: `callout-${index}` }
			});
			checkbox.checked = this.selectedCallouts.has(index);
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) {
					this.selectedCallouts.add(index);
				} else {
					this.selectedCallouts.delete(index);
				}
			});

			// 创建标签
			const label = itemDiv.createEl('label', {
				attr: { for: `callout-${index}` },
				cls: 'obshare-callout-label'
			});

			// 显示 Callout 类型和内容预览
			label.createEl('span', {
				text: `[!${callout.type}]`,
				cls: 'obshare-callout-type'
			});
			
			const contentPreview = callout.content.length > 50 
				? callout.content.substring(0, 50) + '...' 
				: callout.content;
			label.createEl('span', {
				text: ` ${contentPreview}`,
				cls: 'obshare-callout-content'
			});
		});

		// 添加全选/取消全选按钮
		const buttonContainer = contentEl.createDiv({ cls: 'obshare-callout-buttons' });
		
		const selectAllBtn = buttonContainer.createEl('button', {
			text: '全选',
			cls: 'mod-cta'
		});
		selectAllBtn.addEventListener('click', () => {
			this.callouts.forEach((_, index) => {
				this.selectedCallouts.add(index);
				const checkbox = contentEl.querySelector<HTMLInputElement>(`#callout-${index}`);
				if (checkbox) checkbox.checked = true;
			});
		});

		const deselectAllBtn = buttonContainer.createEl('button', {
			text: '取消全选'
		});
		deselectAllBtn.addEventListener('click', () => {
			this.selectedCallouts.clear();
			this.callouts.forEach((_, index) => {
				const checkbox = contentEl.querySelector<HTMLInputElement>(`#callout-${index}`);
				if (checkbox) checkbox.checked = false;
			});
		});

		// 添加确认和取消按钮
		const actionContainer = contentEl.createDiv({ cls: 'obshare-modal-button-container' });
		
		const confirmBtn = actionContainer.createEl('button', {
			text: '开始转换',
			cls: 'mod-cta'
		});
		confirmBtn.addEventListener('click', () => {
			if (this.selectedCallouts.size === 0) {
				new Notice('请至少选择一个 callout 进行转换');
				return;
			}
			this.onConfirm(Array.from(this.selectedCallouts));
			this.close();
		});

		const cancelBtn = actionContainer.createEl('button', {
			text: '取消'
		});
		cancelBtn.addEventListener('click', () => {
			this.close();
		});
	}

	override onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

void CalloutConversionModal;

class UploadProgressModal extends Modal {
	private progressBar!: HTMLElement;
	private progressText!: HTMLElement;
	private stepText!: HTMLElement;
	private titleElement!: HTMLElement; // 添加标题元素引用
	private currentProgress: number = 0;
	private currentStep: string = '';
	private isCompleted: boolean = false;
	private fakeProgressTimer: NodeJS.Timeout | null = null;
	private lastRealProgress: number = 0;
	private maxFakeProgress: number = 90; // 伪进度最大值

	constructor(app: App) {
		super(app);
	}

	override onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('obshare-feishu-upload-progress-modal');

		const titleText = '正在上传文档';
		const titleSetting = new Setting(contentEl).setName(titleText).setHeading();
		this.titleElement = titleSetting.nameEl;
		this.titleElement.addClass('obshare-progress-modal-title');

		// 步骤提示
		this.stepText = contentEl.createEl('div', { text: '准备上传...', cls: 'obshare-progress-modal-step' });

		// 进度条容器
		const progressContainer = contentEl.createDiv('obshare-feishu-upload-progress'); // 使用 CSS 中定义的类名

		// 进度文本
		this.progressText = progressContainer.createEl('div', { text: '0%', cls: 'obshare-progress-text' });

		// 进度条背景
		const progressBarBg = progressContainer.createEl('div', { cls: 'obshare-progress-bar' });
		
		// 进度条填充
		this.progressBar = progressBarBg.createEl('div', { cls: 'obshare-progress-fill' });
		this.progressBar.setCssProps({ '--obshare-progress-width': '0%' });

		// 步骤提示
		this.stepText = contentEl.createEl('div', { text: '准备上传...', cls: 'obshare-progress-modal-step' });

		// 提示文本
		contentEl.createEl('div', { text: '请保持网络连接，不要关闭此窗口', cls: 'obshare-progress-hint' });
		
		// 启动伪进度
		this.startFakeProgress();
	}

	/**
	 * 更新进度
	 * @param progress 进度百分比 (0-100)
	 * @param step 当前步骤描述
	 */
	updateProgress(progress: number, step: string) {
		const targetProgress = Math.min(100, Math.max(0, progress));
		
		// 如果是真实进度更新，停止伪进度并更新
		if (targetProgress > this.lastRealProgress) {
			this.lastRealProgress = targetProgress;
			this.stopFakeProgress();
			this.setProgress(targetProgress);
			
			// 如果进度小于最大伪进度值，重新启动伪进度
			if (targetProgress < this.maxFakeProgress && !this.isCompleted) {
				this.startFakeProgress();
			}
		}
		
		this.currentStep = step;
		if (this.stepText) {
			this.stepText.textContent = step;
		}
	}

	/**
	 * 设置进度条显示
	 * @param progress 进度百分比
	 */
	private setProgress(progress: number) {
		this.currentProgress = progress;
		
		if (this.progressBar) {
			this.progressBar.setCssProps({ '--obshare-progress-width': `${this.currentProgress}%` });
		}
		
		if (this.progressText) {
			this.progressText.textContent = `${Math.round(this.currentProgress)}%`;
		}
	}

	/**
	 * 启动伪进度
	 */
	private startFakeProgress() {
		this.stopFakeProgress(); // 确保没有重复的定时器
		
		const fakeProgressStep = () => {
			if (this.isCompleted) {
				return;
			}
			
			// 计算伪进度增量，越接近最大值增长越慢
			const remainingProgress = this.maxFakeProgress - this.currentProgress;
			if (remainingProgress > 0) {
				const increment = Math.max(0.1, remainingProgress * 0.02); // 最小增量0.1%
				const newProgress = Math.min(this.maxFakeProgress, this.currentProgress + increment);
				this.setProgress(newProgress);
				
				// 继续下一次更新
				this.fakeProgressTimer = setTimeout(fakeProgressStep, 200);
			}
		};
		
		// 启动伪进度
		this.fakeProgressTimer = setTimeout(fakeProgressStep, 200);
	}

	/**
	 * 停止伪进度
	 */
	private stopFakeProgress() {
		if (this.fakeProgressTimer) {
			clearTimeout(this.fakeProgressTimer);
			this.fakeProgressTimer = null;
		}
	}

	/**
	 * 标记为完成状态
	 */
	complete() {
		this.isCompleted = true;
		this.stopFakeProgress();
		this.setProgress(100);
		this.currentStep = '上传完成，正在设置权限...';
		if (this.stepText) {
			this.stepText.textContent = this.currentStep;
		}
		
		// 延迟关闭，让用户看到完成状态
		setTimeout(() => {
			this.close();
		}, 800);
	}

	/**
	 * 显示错误状态
	 * @param errorMessage 错误信息
	 */
	showError(errorMessage: string) {
		if (this.stepText) {
			this.stepText.textContent = `上传失败: ${errorMessage}`;
			this.stepText.addClass('obshare-progress-error');
		}

		if (this.progressBar) {
			this.progressBar.addClass('obshare-progress-error');
		}

		// 3秒后自动关闭
		setTimeout(() => {
			this.close();
		}, 3000);
	}

	override onClose() {
		this.stopFakeProgress(); // 清理定时器
		const { contentEl } = this;
		contentEl.empty();
	}
}

class UserAgreementModal extends Modal {
	private plugin: FeishuUploaderPlugin;
	private component: Component;

	constructor(app: App, plugin: FeishuUploaderPlugin) {
		super(app);
		this.plugin = plugin;
		this.component = new Component();
	}

	override onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('obshare-user-agreement-modal');

		// 标题
		new Setting(contentEl).setName('Obshare 用户协议').setHeading();

		// 协议内容容器（可滚动）
		const agreementContainer = contentEl.createDiv({ cls: 'obshare-agreement-content' });

		// 协议内容（Markdown格式）
		const agreementText = `欢迎使用 obshare（以下简称"本插件"）。在使用本插件之前，请您仔细阅读并理解以下条款。使用本插件即视为您已同意并遵守本协议。

本插件是一款用于将您储存在本地Obsidian笔记通过飞书（下称"目标服务"）开放平台 api 接口上传到您的飞书账号所属的云空间/云文档，从而使得您可以更加方便分享和管理自己的笔记。

当您使用插件将笔记上传至飞书文档时：该文档的内容由您提供；文档的可见性（公开/私有）权限设置由您控制；若开启公开链接，任何能访问链接的人都可查看。

一旦数据离开您的设备进入目标服务（"飞书"及其他可能的服务商），后续的存储、访问、分享、缓存、日志记录等都遵循其自身的隐私政策与服务条款。您理解，如飞书发生数据泄露、文档误删或接口变更导致上传失败等情况，与本插件无关。

## 一、隐私与安全

1. **所有数据处理均在本地完成。** 我们高度重视您的隐私，本插件的所有功能运行均在您的设备本地进行，上传行为将只在您的设备与目标服务（"飞书"及其他可能的服务商）之间进行，不会将任何内容、笔记、配置或元数据上传至任何第三方。

2. **绝不收集、存储或传输用户数据。** 我们**不收集、不分析、不共享**任何用户的笔记内容、文件路径、标签、设置信息或其他个人数据。无论何种情况，您的数据始终属于您本人。您的相关设置信息、敏感令牌或其他使用本插件时产生的数据，将储存在您的设备本地，您可以在本插件文件夹 \`data.json\` 中随时查看。

3. **无监控、无追踪、无广告。** 本插件不会启用任何形式的数据追踪、用户行为监控、性能统计或广告投放机制。

4. **透明与可审计**。本插件源代码完全开源，您可以自由查看、审查和验证其行为。我们鼓励社区参与代码审计，共同维护隐私安全。

## 二、上传行为责任说明

1. **插件本身不主动上传数据**。本插件不会自动或默认将任何内容上传至互联网。若某功能涉及网络请求（如下载模板、获取更新、访问公开 API 等），该行为必须由用户主动触发，或者将明确提示用户，并需用户**主动确认**后方可执行。

2. **用户自行承担上传风险**。若您在使用本插件时选择通过其功能上传文件、同步到云服务、发送至外部接口等操作，**该行为完全由您自主决定**。您应充分了解目标服务（"飞书"及其他可能的服务商）的隐私政策及数据处理方式，并自行承担由此产生的任何风险。若您开启互联网公开功能，你需要遵守目标服务的管理规定，该功能开启后，互联网上获得链接的人都能够访问该文档。您作为文档所有者，需对其合法合规性负责，与本插件无关。

3. **我们不对第三方服务负责**。一旦数据离开您的设备，其后续处理不再受本插件控制。我们不对第三方平台的行为、数据泄露、滥用或丢失承担责任。

## 三、知识产权与许可

1. **插件著作权归属**。本插件及其所有源代码、文档、图标、界面设计等内容（以下简称"作品"）的著作权及相关知识产权均归原作者及贡献者所有。未经书面许可，任何单位或个人不得以复制、修改、分发、商业使用等方式使用本作品。

2. **用户内容所有权**。您在使用本插件过程中上传至飞书或其他目标服务的所有笔记内容、文档、图片、元数据等（以下简称"用户内容"），其知识产权始终归属于您本人。本插件不主张对任何用户内容享有权利。

## 四、责任限制与免责条款

1. **无明示或暗示担保**。本插件按"现状"和"可用"基础提供，作者及维护团队**不作任何明示或暗示的保证**，包括但不限于：适销性、特定用途适用性、不侵权、无错误或中断、持续可用性等。使用本插件的风险由您自行承担。

2. **不承担间接损失**。在任何情况下，无论基于合同、侵权、严格责任或其他法律理论，作者及关联方均不对因使用或无法使用本插件而导致的**任何间接、附带、特殊、后果性损害**（包括但不限于数据丢失、业务中断、利润损失、信息泄露）承担责任。

3. **服务中断或接口变更风险**。飞书及其他目标服务商可能随时调整其 API 接口规范、访问策略或终止服务。若因上述原因导致本插件功能失效、上传失败或数据异常，作者不承担任何责任。建议您定期备份重要数据，并关注目标平台公告。

4. **用户行为合规义务**。您承诺在使用本插件上传内容时，遵守您所在地区相关法律法规定。禁止上传含有违法不良信息、侵犯他人版权、隐私权或商业秘密的内容。若因上传内容引发纠纷或法律责任，由您自行承担全部后果。

## 五、协议修改与终止

1. **协议更新通知**。作者保留随时修订本协议的权利。重大变更将通过 Obsidian 插件市场公告、GitHub 发布说明等方式通知用户。继续使用本插件即视为接受最新版本协议。

2. **用户自主退出机制**。您可随时卸载本插件或删除本地配置文件（如 \`data.json\`）以终止使用。一旦卸载，所有本地缓存数据将被清除，但您在飞书等外部平台已经上传的内容不会因此删除，仍需您自行处理，您仍需对上传至飞书等外部平台的内容负责。

3. **插件终止使用**。若发现本插件存在严重安全漏洞、恶意行为或违反开源原则的情况，作者有权立即停止维护或发布终止版本。届时建议用户尽快迁移数据并停止使用。`;

		// 使用MarkdownRenderer渲染协议内容
		void MarkdownRenderer.render(this.app, agreementText, agreementContainer, '', this.component);

		// 按钮容器
		const buttonContainer = contentEl.createDiv({ cls: 'obshare-agreement-buttons' });

		// 拒绝按钮
		const rejectButton = buttonContainer.createEl('button', { 
			text: '拒绝'
		});
		rejectButton.onclick = () => {
			this.close();
			new Notice('您已拒绝用户协议，插件功能将不可用。', 5000);
		};

		// 同意按钮
		const agreeButton = buttonContainer.createEl('button', { 
			text: '同意并继续',
			cls: 'mod-cta'
		});
		agreeButton.onclick = () => {
			void (async () => {
				this.plugin.settings.agreedToTerms = true;
				await this.plugin.saveSettings();
				
				this.plugin.completeInitialization();
				
				this.close();
				new Notice('欢迎使用 obshare！', 3000);
			})();
		};
	}

	override onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
