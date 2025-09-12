import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, MarkdownRenderer, Component } from 'obsidian';
import { FeishuApiClient, createFeishuClient } from './feishu-api';
import { CryptoUtils } from './crypto-utils';
import { CalloutConverter, CalloutInfo } from './callout-converter';

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
	lastResetDate: new Date().toISOString().substring(0, 7) // 当前年月
}

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

	override async onload() {
		await this.loadSettings();
		
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
				this.uploadCurrentDocument();
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
							.onClick(async () => {
								await this.uploadFile(file);
							});
					});
				}
			})
		);

		// 添加ribbon按钮
		this.addRibbonIcon('share', '分享当前页面', (evt: MouseEvent) => {
			this.uploadCurrentDocument();
		});

		// 添加设置选项卡
		this.addSettingTab(new FeishuUploaderSettingTab(this.app, this));
	}
	
	/**
	 * 初始化飞书API客户端
	 */
	private initializeFeishuClient(): void {
		console.log('[飞书插件] 初始化客户端，当前设置:', {
			appId: this.settings.appId ? '已配置' : '未配置',
			appSecret: this.settings.appSecret ? '已配置' : '未配置',
			userId: this.settings.userId ? '已配置' : '未配置',
			folderToken: this.settings.folderToken ? '已配置' : '未配置',

		});
		
		if (this.settings.appId && this.settings.appSecret) {
			// 创建异步回调包装函数
			const asyncCallback = () => {
				this.incrementApiCallCount().catch(error => {
					console.error('[飞书插件] API调用计数更新失败:', error);
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
			
			console.log('[飞书插件] 客户端初始化成功');
		} else {
			this.feishuClient = null;
			this.feishuRichClient = null;
			console.log('[飞书插件] 客户端初始化失败：缺少appId或appSecret');
		}
	}

	override onunload() {
		// 清理通知管理器
		this.notificationManager.clearAll();
		// 清理资源
	}

	async loadSettings() {
		const loadedData = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
		
		// 检查是否有明文敏感数据需要加密
		const sensitiveFields = ['appId', 'appSecret', 'folderToken', 'userId'] as const;
		let hasPlaintextData = false;
		for (const field of sensitiveFields) {
			const value = (loadedData as any)?.[field];
			if (value && typeof value === 'string' && !CryptoUtils.isEncryptedData(value)) {
				hasPlaintextData = true;
				break;
			}
		}
		
		// 解密敏感设置数据
		this.settings = await CryptoUtils.decryptSensitiveSettings(this.settings);
		
		// 初始化敏感数据哈希
		const sensitiveData = sensitiveFields.map(field => (this.settings as any)[field] || '').join('|');
		this.lastSensitiveDataHash = await this.simpleHash(sensitiveData);
		
		// 如果检测到明文数据，自动加密保存
		if (hasPlaintextData) {
			console.log('[飞书插件] 检测到明文敏感数据，正在自动加密...');
			const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
			await this.saveData(encryptedSettings);
			console.log('[飞书插件] 明文数据已自动加密保存');
		}
		
		// 向后兼容性处理：为现有历史记录添加默认docToken
		if (this.settings.uploadHistory) {
			this.settings.uploadHistory.forEach(item => {
				if (!item.docToken) {
					item.docToken = '未知';
				}
			});
		}
		
		console.log('[飞书插件] 设置加载完成并解密:', {
			appId: this.settings.appId ? '已配置' : '未配置',
			appSecret: this.settings.appSecret ? '已配置' : '未配置',
			userId: this.settings.userId ? '已配置' : '未配置',
			folderToken: this.settings.folderToken ? '已配置' : '未配置',
			
		});
	}

	async saveSettings() {
		// 加密敏感数据后保存
		const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
		await this.saveData(encryptedSettings);
		
		// 保存设置后重新初始化客户端
		this.initializeFeishuClient();
		
		console.log('[飞书插件] 设置已加密保存:', {
			appId: this.settings.appId ? '已配置' : '未配置',
			appSecret: this.settings.appSecret ? '已配置' : '未配置',
			userId: this.settings.userId ? '已配置' : '未配置',
			folderToken: this.settings.folderToken ? '已配置' : '未配置',
			
		});
	}

	/**
	 * 优化的保存方法：只在必要时进行加密
	 */
	private async saveDataOptimized(): Promise<void> {
		// 计算当前敏感数据的哈希
		const sensitiveFields = ['appId', 'appSecret', 'folderToken', 'userId'] as const;
		const sensitiveData = sensitiveFields.map(field => (this.settings as any)[field] || '').join('|');
		const currentHash = await this.simpleHash(sensitiveData);
		
		// 如果敏感数据没有变化，直接保存原始数据
		if (this.lastSensitiveDataHash === currentHash) {
			await this.saveData(this.settings);
			console.log('[飞书插件] 数据已保存（无需重新加密）');
			return;
		}
		
		// 敏感数据有变化，需要加密
		const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
		await this.saveData(encryptedSettings);
		this.lastSensitiveDataHash = currentHash;
		console.log('[飞书插件] 数据已加密保存');
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
		console.log('[飞书插件] 开始上传文件:', file.name);
		console.log('[飞书插件] 当前配置状态:', {
			feishuClient: this.feishuClient ? '已初始化' : '未初始化',
			feishuRichClient: this.feishuRichClient ? '已初始化' : '未初始化',
			appId: this.settings.appId ? '已配置' : '未配置',
			appSecret: this.settings.appSecret ? '已配置' : '未配置',
			userId: this.settings.userId ? '已配置' : '未配置',
			folderToken: this.settings.folderToken ? '已配置' : '未配置',
			
		});
		
		// 根据上传模式选择客户端
		const client = this.feishuClient;
		
		if (!client) {
			console.error('[飞书插件] 上传失败：客户端未初始化');
			this.notificationManager.showNotice('请先在设置中配置飞书应用凭证', 5000, 'missing-credentials');
			return;
		}

		if (!this.settings.folderToken) {
			console.error('[飞书插件] 上传失败：文件夹Token未配置');
			this.notificationManager.showNotice('请先在设置中配置飞书文件夹Token', 5000, 'missing-folder-token');
			return;
		}

		// 创建并显示进度条弹窗
		const progressModal = new UploadProgressModal(this.app);
		progressModal.open();

		try {
			// 步骤1: 准备上传
			progressModal.updateProgress(10, '正在读取文档内容...');
			
			// 读取文件内容
			const content = await this.app.vault.read(file);
			const title = file.basename;

			// 步骤2: 分析文档
			progressModal.updateProgress(20, '正在分析文档格式...');
			
			// 同步检测图片和Callout
			const hasImages = /!\[\[.*?\]\]/.test(content);
			
			// 检测并缓存Callout内容
			let cachedCallouts: CalloutInfo[] = [];
			if (this.feishuClient) {
				const calloutConverter = new CalloutConverter(this.feishuClient);
				cachedCallouts = calloutConverter.extractCallouts(content);
				console.log(`[飞书插件] 检测到 ${cachedCallouts.length} 个 Callout，已缓存内容`);
			}
			
			console.log(`[飞书插件] 检测到${hasImages ? '有' : '无'}图片，使用${hasImages ? '富文本' : '简单'}模式上传`);
			
			// 步骤3: 开始上传
			progressModal.updateProgress(30, '正在上传文档到飞书云...');
			
			let result: { token: string; url: string };
			
			if (hasImages) {
				// 有图片：使用富文本模式
				result = await this.feishuRichClient!.uploadDocument(
					file.name, // 完整文件名（包含扩展名）用于上传到云空间
					content,
					this.settings.folderToken,
					(status: string) => {
						// 根据状态更新进度
						if (status.includes('创建导入任务')) {
							progressModal.updateProgress(50, '正在创建导入任务...');
						} else if (status.includes('等待处理')) {
							progressModal.updateProgress(60, '文档正在处理中...');
						} else if (status.includes('处理中')) {
							progressModal.updateProgress(70, '正在转换文档格式...');
						}
					}
				);
			} else {
				// 无图片：使用简单模式
				result = await this.feishuClient!.uploadDocument(
					file.name, // 完整文件名（包含扩展名）用于上传到云空间
					content,
					this.settings.folderToken,
					(status: string) => {
						// 根据状态更新进度
						if (status.includes('创建导入任务')) {
							progressModal.updateProgress(50, '正在创建导入任务...');
						} else if (status.includes('等待处理')) {
							progressModal.updateProgress(60, '文档正在处理中...');
						} else if (status.includes('处理中')) {
							progressModal.updateProgress(70, '正在转换文档格式...');
						}
					}
				);
			}

			// 步骤4: 处理Callout
			if (cachedCallouts.length > 0) {
				progressModal.updateProgress(80, '正在处理标注块...');
				// 自动处理 Callout 转换（使用缓存的Callout内容）
				await this.autoConvertCallouts(result.token, cachedCallouts);
			}
			
			// 步骤5: 完成上传
			progressModal.complete();
			
			// 立即添加到历史记录（无权限设置）
			await this.addUploadHistory(title, result.url, result.token);
			
			// 显示权限设置对话框
			new DocumentPermissionModal(this.app, result.token, result.url, title, this, false).open();
			
		} catch (error) {
			console.error('[飞书插件] 上传失败:', error);
			
			let userMessage = '';
			const errorMessage = error instanceof Error ? error.message : String(error);
			
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
				userMessage = 'API认证失败，请检查：\n1. App ID 和 App Secret 是否正确\n2. 应用权限是否配置正确\n3. 网络是否能访问飞书API';
			} else if (errorMessage.includes('文件夹')) {
				userMessage = '文件夹配置错误，请检查：\n1. 文件夹Token是否正确\n2. 是否有文件夹写入权限';
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
				console.log(`[飞书插件] 使用缓存的 ${cachedCallouts.length} 个 Callout，开始自动转换`);
				console.log('[飞书插件] 缓存的 Callouts:', cachedCallouts);
				
				const calloutConverter = new CalloutConverter(this.feishuClient);
				
				// 等待一下确保文档完全同步
				await new Promise(resolve => setTimeout(resolve, 1000));
				
				// 获取文档的所有块
				const documentBlocks = await this.feishuClient.getDocumentBlocksDetailed(docToken);
				if (!documentBlocks || documentBlocks.length === 0) {
					console.warn('[飞书插件] 无法获取文档块信息，跳过 Callout 转换');
					return;
				}
				
				console.log(`[飞书插件] 获取到 ${documentBlocks.length} 个文档块`);
				
				// 为文档块添加索引信息
				const blocksWithIndex = calloutConverter.addIndexToBlocks(documentBlocks);
				console.log(`[飞书插件] 已为 ${blocksWithIndex.length} 个文档块添加索引信息`);
				
				// 打印引用块信息
				const quoteBlocks = blocksWithIndex.filter(block => block.block_type === 15);
				console.log(`[飞书插件] 找到 ${quoteBlocks.length} 个引用块 (type=15):`, quoteBlocks);
				
				// 打印所有块类型统计
				const blockTypes = blocksWithIndex.reduce((acc: Record<number, number>, block) => {
					acc[block.block_type] = (acc[block.block_type] || 0) + 1;
					return acc;
				}, {});
				console.log('[飞书插件] 文档块类型统计:', blockTypes);
				
				// 查找匹配的引用块
				const matches = calloutConverter.findMatchingQuoteBlocks(blocksWithIndex, cachedCallouts);
				if (matches.length === 0) {
					console.log('[飞书插件] 未找到匹配的引用块，可能文档中没有对应的 Callout 引用块');
					return;
				}
				
				// 逐个处理 Callout 转换（先插入后删除）
				let convertedCount = 0;
				for (const { callout, block } of matches) {
					const success = await calloutConverter.processSingleCalloutConversion(
						docToken,
						callout,
						block
					);
					if (success) {
						convertedCount++;
					}
				}
				
				console.log(`[飞书插件] 成功转换 ${convertedCount} 个 Callout`);
			} else {
				console.log('[飞书插件] 缓存中无 Callout，跳过转换');
			}
		} catch (error) {
			console.error('[飞书插件] Callout 自动转换出错:', error);
			// 转换失败不影响主流程，继续执行
		}
	}

	/**
	 * 显示重试对话框
	 */
	private showRetryDialog(file: TFile): void {
		const modal = new RetryModal(this.app, () => {
			// 重试上传
			this.uploadFile(file);
		});
		modal.open();
	}

	/**
	 * 添加上传历史记录
	 */
	async addUploadHistory(title: string, url: string, docToken: string, permissions?: { isPublic: boolean; allowCopy: boolean; allowCreateCopy: boolean }): Promise<void> {
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
			...(permissions && { permissions })
		};
		
		// 添加到历史记录开头
		this.settings.uploadHistory.unshift(historyItem);
		
		// 增加上传次数
		this.settings.uploadCount++;
		
		// 文档记录永久保存，不进行清理
		
		// 只保存数据，不重新初始化客户端（加密敏感数据）
		const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
		this.saveData(encryptedSettings);
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
			this.saveData(encryptedSettings);
			console.log('[飞书插件] 历史记录权限已更新:', { docToken, permissions });
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
			this.saveData(encryptedSettings);
			console.log('[飞书插件] 历史记录项已删除:', { docToken });
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
			console.log('[飞书插件] 文件和历史记录删除成功:', { docToken, title });
		} catch (error) {
			console.error('[飞书插件] 删除文件失败:', error);
			const errorMessage = error instanceof Error ? error.message : String(error);
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
		this.saveData(encryptedSettings);
		console.log('[飞书插件] 已清空上传历史记录');
		this.notificationManager.showNotice('已清空上传历史记录', 3000, 'history-cleared');
	}

	/**
	 * 重置上传次数
	 */
	async resetUploadCount(): Promise<void> {
		this.settings.uploadCount = 0;
		// 只保存数据，不重新初始化客户端（加密敏感数据）
		const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
		this.saveData(encryptedSettings);
		console.log('[飞书插件] 已重置上传次数');
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
		this.saveData(encryptedSettings);
		
		// 获取调用栈信息以便调试
		const stack = new Error().stack;
		const callerLine = stack?.split('\n')[2]?.trim() || '未知调用者';
		console.log('[飞书插件] 🔢 API调用次数已增加，当前:', this.settings.apiCallCount, '调用者:', callerLine);
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
			console.log('[飞书插件] 检测到新月份，自动重置API调用次数');
			this.settings.apiCallCount = 0;
			this.settings.lastResetDate = currentMonth;
			// 只保存数据，不重新初始化客户端（加密敏感数据）
			const encryptedSettings = await CryptoUtils.encryptSensitiveSettings(this.settings);
			this.saveData(encryptedSettings);
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
		this.saveData(encryptedSettings);
		console.log('[飞书插件] 🔄 已手动重置API调用次数，当前计数:', this.settings.apiCallCount);
		this.notificationManager.showNotice('已重置API调用次数', 3000, 'api-count-reset');
	}

	/**
	 * 测试网络连接
	 */
	async testNetworkConnection(): Promise<boolean> {
		try {
			console.log('[飞书插件] 开始测试网络连接');
			if (!this.feishuClient) {
				console.error('[飞书插件] 客户端未初始化，无法测试连接');
				return false;
			}
			
			const result = await this.feishuClient.testConnection();
			// 增加API调用计数
			this.incrementApiCallCount();
			console.log('[飞书插件] 网络连接测试结果:', result);
			return result;
		} catch (error) {
			console.error('[飞书插件] 网络连接测试失败:', error);
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
		contentEl.addClass('feishu-permission-modal');

		contentEl.createEl('h2', { text: '设置文档权限' });
		contentEl.createEl('p', { text: `为文档 "${this.title}" 设置访问权限` });

		// 权限选项
		const permissionContainer = contentEl.createDiv('permission-options');
		
		// 是否公开
		const publicOption = permissionContainer.createDiv('permission-option');
		const publicCheckbox = publicOption.createEl('input', { type: 'checkbox' });
		publicCheckbox.id = 'isPublic';
		publicCheckbox.style.marginBottom = '8px';
		const publicLabel = publicOption.createEl('label', { text: '是否公开文档？', attr: { for: 'isPublic' } });
		publicLabel.createEl('div', { text: '若您开启，您需要遵守飞书的相关协议，您作为文档所有者，需对其合法合规性负责，任何由此产生的纠纷与本插件无关。', cls: 'option-desc' });

		// 是否允许复制
		const copyOption = permissionContainer.createDiv('permission-option');
		const copyCheckbox = copyOption.createEl('input', { type: 'checkbox' });
		copyCheckbox.id = 'allowCopy';
		copyCheckbox.style.marginBottom = '8px';
		copyCheckbox.disabled = true; // 默认禁用
		const copyLabel = copyOption.createEl('label', { text: '是否允许复制？', attr: { for: 'allowCopy' } });
		copyLabel.createEl('div', { text: '允许用户复制文档内容', cls: 'option-desc' });

		// 是否允许创建副本、打印、下载
		const copyCreateOption = permissionContainer.createDiv('permission-option');
		const copyCreateCheckbox = copyCreateOption.createEl('input', { type: 'checkbox' });
		copyCreateCheckbox.id = 'allowCreateCopy';
		copyCreateCheckbox.style.marginBottom = '8px';
		copyCreateCheckbox.disabled = true; // 默认禁用
		const copyCreateLabel = copyCreateOption.createEl('label', { text: '是否允许创建副本、打印、下载？', attr: { for: 'allowCreateCopy' } });
		copyCreateLabel.createEl('div', { text: '允许用户创建文档副本、打印和下载文档', cls: 'option-desc' });

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
			copyOption.style.opacity = isPublic ? '1' : '0.5';
			copyCreateOption.style.opacity = isPublic ? '1' : '0.5';
			copyOption.style.pointerEvents = isPublic ? 'auto' : 'none';
			copyCreateOption.style.pointerEvents = isPublic ? 'auto' : 'none';
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
		const buttonContainer = contentEl.createDiv('modal-button-container');
		
		const submitButton = buttonContainer.createEl('button', { text: '提交设置', cls: 'mod-cta' });
		submitButton.onclick = async () => {
			// 收集用户选择
			const isPublic = (publicCheckbox as HTMLInputElement).checked;
			const allowCopy = (copyCheckbox as HTMLInputElement).checked;
			const allowCreateCopy = (copyCreateCheckbox as HTMLInputElement).checked;
			
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
					throw new Error('请先在设置中配置您的飞书用户ID');
				}
				
				console.log('[飞书插件] 使用配置的用户ID:', this.plugin.settings.userId);
				
				// 根据调用来源选择不同的API方法
				if (this.isFromSettings) {
					// 从设置页面调用：仅更新权限，不转移所有权
					await this.plugin.feishuClient!.updateDocumentPermissionsOnly(this.docToken, permissions);
				} else {
					// 从上传流程调用：设置权限并转移所有权
					await this.plugin.feishuClient!.setDocumentPermissions(this.docToken, permissions, this.plugin.settings.userId);
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
				this.plugin.updateHistoryPermissions(this.docToken, permissionsToSave);
				
				new UploadResultModal(this.app, this.docUrl, this.title).open();
			} else {
				// 从设置页面调用时更新历史记录中的权限设置
				this.plugin.updateHistoryPermissions(this.docToken, permissionsToSave);
				this.plugin.notificationManager.showNotice('文档权限设置成功', 3000);
			}
				
			} catch (error) {
				console.error('[飞书插件] 权限设置失败:', error);
				const errorMessage = error instanceof Error ? error.message : String(error);
				this.plugin.notificationManager.showNotice(`权限设置失败: ${errorMessage}`, 5000, 'permission-error');
				
				// 恢复按钮状态
				submitButton.disabled = false;
				submitButton.textContent = '提交设置';
			}
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
		contentEl.addClass('feishu-success-modal');

		contentEl.createEl('h2', { text: '上传成功！' });
		contentEl.createEl('p', { text: `文档 "${this.title}" 已成功上传到飞书云文档` });

		const linkEl = contentEl.createEl('a', {
			text: this.url,
			href: this.url
		});
		linkEl.setAttribute('target', '_blank');

		const buttonContainer = contentEl.createDiv('modal-button-container');
		
		const copyButton = buttonContainer.createEl('button', { text: '复制链接' });
		copyButton.onclick = () => {
			navigator.clipboard.writeText(this.url);
			new Notice('链接已复制到剪贴板');
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
		contentEl.createEl('h2', { text: '网络连接失败' });

		// 说明文字
		const descEl = contentEl.createEl('div', { cls: 'retry-modal-desc' });
		descEl.createEl('p', { text: '上传失败，可能是网络连接问题。' });
		descEl.createEl('p', { text: '请检查网络连接后重试，或稍后再试。' });

		// 按钮容器
		const buttonContainer = contentEl.createEl('div', { cls: 'retry-modal-buttons' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.gap = '10px';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.marginTop = '20px';

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

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h1', { text: '基础设置' });

		// 说明文档
		const descEl = containerEl.createDiv();
		descEl.createEl('p', { text: '你需要配置飞书应用App ID、App secret、您的飞书用户ID、您的文件夹token才能正常启动此插件' });
		descEl.createEl('p').innerHTML = '完成配置预计需要5-10分钟，请参阅：<a href="https://itlueqqx8t.feishu.cn/docx/XUJmdxbf7octOFx3Vt0c3KJ3nWe" target="_blank">快速配置您的ObShare</a>';

		// App ID设置
		const appIdSetting = new Setting(containerEl)
			.setName('App ID')
			.setDesc('飞书应用的App ID')
			.addText(text => text
				.setPlaceholder('输入App ID')
				.setValue(this.plugin.settings.appId)
				.onChange(async (value) => {
					this.plugin.settings.appId = value;
					await this.plugin.saveSettings();
				}));
		appIdSetting.nameEl.innerHTML = 'App ID <span style="color: red;">*</span>';

		// App Secret设置
		const appSecretSetting = new Setting(containerEl)
			.setName('App Secret')
			.setDesc('飞书应用的App Secret')
			.addText(text => text
				.setPlaceholder('输入App Secret')
				.setValue(this.plugin.settings.appSecret)
				.onChange(async (value) => {
					this.plugin.settings.appSecret = value;
					await this.plugin.saveSettings();
				}));
		appSecretSetting.nameEl.innerHTML = 'App Secret <span style="color: red;">*</span>';

		// 用户ID设置
		const userIdSetting = new Setting(containerEl)
			.setName('用户ID')
			.setDesc('您的飞书用户ID')
			.addText(text => text
				.setPlaceholder('输入您的飞书用户ID')
				.setValue(this.plugin.settings.userId)
				.onChange(async (value) => {
					this.plugin.settings.userId = value;
					await this.plugin.saveSettings();
				}));
		userIdSetting.nameEl.innerHTML = '用户ID <span style="color: red;">*</span>';



		// 文件夹Token设置
		const folderTokenSetting = new Setting(containerEl)
			.setName('文件夹Token')
			.setDesc('飞书云空间文件夹的Token，文档将上传到此文件夹')
			.addText(text => text
				.setPlaceholder('输入文件夹Token')
				.setValue(this.plugin.settings.folderToken)
				.onChange(async (value) => {
					this.plugin.settings.folderToken = value;
					await this.plugin.saveSettings();
				}));
		folderTokenSetting.nameEl.innerHTML = '文件夹Token <span style="color: red;">*</span>';

		// 测试连接按钮
		new Setting(containerEl)
			.setName('测试连接')
			.setDesc('测试飞书API连接是否正常')
			.addButton(button => button
				.setButtonText('测试连接')
				.onClick(async () => {
					if (!this.plugin.feishuClient) {
						this.plugin.notificationManager.showNotice('请先配置App ID和App Secret', 4000, 'missing-config');
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
				}));

		// 数据统计
		containerEl.createEl('h1', { text: '数据统计' });
		
		// 显示分享文档数
		new Setting(containerEl)
			.setName('分享文档数')
			.setDesc(`您已成功分享 ${this.plugin.settings.uploadCount} 个文档`)
			.addButton(button => button
				.setButtonText('重置计数')
				.setWarning()
				.onClick(() => {
					this.plugin.resetUploadCount();
					this.display(); // 刷新设置页面
				}));

		// 显示本月API调用次数
		const currentMonth = new Date().toISOString().substring(0, 7);
		const isCurrentMonth = this.plugin.settings.lastResetDate === currentMonth;
		const displayCount = isCurrentMonth ? this.plugin.settings.apiCallCount : 0;
		new Setting(containerEl)
			.setName('本月API调用次数')
			.setDesc(`本月已调用飞书API ${displayCount} 次`)
			.addButton(button => button
				.setButtonText('重置计数')
				.setWarning()
				.onClick(() => {
					this.plugin.resetApiCallCount();
					this.display(); // 刷新设置页面
				}));

		// 发布管理
		containerEl.createEl('h1', { text: '分享管理' });
		
		if (this.plugin.settings.uploadHistory.length === 0) {
			containerEl.createEl('p', { text: '暂无上传记录', cls: 'upload-history-empty' });
		} else {
			// 清空历史记录按钮
			new Setting(containerEl)
				.setName('清空历史记录')
				.setDesc('分享历史记录')
				.addButton(button => button
					.setButtonText('清空')
					.setWarning()
					.onClick(() => {
						this.plugin.clearUploadHistory();
						this.display(); // 刷新设置页面
					}));
			
			// 历史记录列表
			const historyContainer = containerEl.createDiv('upload-history-container');
			
			this.plugin.settings.uploadHistory.forEach((item, index) => {
				const historyItem = historyContainer.createDiv('upload-history-item');
				
				// 标题和时间在同一行
				const headerEl = historyItem.createDiv('upload-history-header');
				
				// 标题（加大加粗）
				const titleEl = headerEl.createEl('div', { 
					text: item.title, 
					cls: 'upload-history-title' 
				});
				
				// 上传时间
				const timeEl = headerEl.createEl('div', { 
					text: item.uploadTime, 
					cls: 'upload-history-time' 
				});
				
				// 链接和复制图标在同一行
				const linkRowEl = historyItem.createDiv('upload-history-link-row');
				
				// 链接
				const linkEl = linkRowEl.createEl('a', { 
					text: item.url, 
					href: item.url,
					cls: 'upload-history-link'
				});
				linkEl.setAttribute('target', '_blank');
				
				// 复制图标
				const copyIcon = linkRowEl.createEl('span', { 
					text: '📋',
					cls: 'upload-history-copy-icon'
				});
				copyIcon.onclick = () => {
					navigator.clipboard.writeText(item.url);
					new Notice('链接已复制到剪贴板');
				};
				
				// 权限管理图标
				const permissionIcon = linkRowEl.createEl('span', {
					text: '⚙️',
					cls: 'upload-history-copy-icon'
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
					text: '🗑️',
					cls: 'upload-history-copy-icon'
				});
				deleteIcon.onclick = async () => {
					// 确认删除
					const confirmed = confirm(`确定要删除文件 "${item.title}" 吗？\n\n注意：此操作将删除飞书云文档中的文件！`);
					if (!confirmed) {
						return;
					}

					// 立即从历史记录中移除
					await this.plugin.deleteHistoryItem(item.docToken);
					
					// 立即刷新设置页面以更新列表显示
					this.display();

					// 异步调用API删除文件
					try {
						if (this.plugin.feishuClient) {
							await this.plugin.feishuClient.deleteFile(item.docToken);
							await this.plugin.incrementApiCallCount();
							console.log('[设置页面] 文件删除成功:', { docToken: item.docToken, title: item.title });
						}
					} catch (error) {
						console.error('[设置页面] API删除文件失败:', error);
						// 检查是否是404错误
						if (error instanceof Error && (error.message.includes('404') || error.message.includes('not found'))) {
							this.plugin.notificationManager.showNotice(
								'删除失败，请您在飞书云文档中自行尝试删除。',
								5000
							);
						} else {
							// 其他错误也显示相同提示
							this.plugin.notificationManager.showNotice(
								'删除失败，请您在飞书云文档中自行尝试删除。',
								5000
							);
						}
					}
				};
			});
		}
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

		contentEl.createEl('h2', { text: 'Callout 转换确认' });
		contentEl.createEl('p', { 
			text: `发现 ${this.callouts.length} 个 Callout 块，请选择要转换为飞书高亮块的项目：` 
		});

		// 创建 Callout 列表
		const listContainer = contentEl.createDiv({ cls: 'callout-list' });
		
		this.callouts.forEach((callout, index) => {
			const itemDiv = listContainer.createDiv({ cls: 'callout-item' });
			
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
				cls: 'callout-label'
			});

			// 显示 Callout 类型和内容预览
			const typeSpan = label.createEl('span', {
				text: `[!${callout.type}]`,
				cls: 'callout-type'
			});
			
			const contentPreview = callout.content.length > 50 
				? callout.content.substring(0, 50) + '...' 
				: callout.content;
			label.createEl('span', {
				text: ` ${contentPreview}`,
				cls: 'callout-content'
			});
		});

		// 添加全选/取消全选按钮
		const buttonContainer = contentEl.createDiv({ cls: 'callout-buttons' });
		
		const selectAllBtn = buttonContainer.createEl('button', {
			text: '全选',
			cls: 'mod-cta'
		});
		selectAllBtn.addEventListener('click', () => {
			this.callouts.forEach((_, index) => {
				this.selectedCallouts.add(index);
				const checkbox = contentEl.querySelector(`#callout-${index}`) as HTMLInputElement;
				if (checkbox) checkbox.checked = true;
			});
		});

		const deselectAllBtn = buttonContainer.createEl('button', {
			text: '取消全选'
		});
		deselectAllBtn.addEventListener('click', () => {
			this.selectedCallouts.clear();
			this.callouts.forEach((_, index) => {
				const checkbox = contentEl.querySelector(`#callout-${index}`) as HTMLInputElement;
				if (checkbox) checkbox.checked = false;
			});
		});

		// 添加确认和取消按钮
		const actionContainer = contentEl.createDiv({ cls: 'modal-button-container' });
		
		const confirmBtn = actionContainer.createEl('button', {
			text: '开始转换',
			cls: 'mod-cta'
		});
		confirmBtn.addEventListener('click', () => {
			if (this.selectedCallouts.size === 0) {
				new Notice('请至少选择一个 Callout 进行转换');
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

		// 添加样式
		const style = contentEl.createEl('style');
		style.textContent = `
			.callout-list {
				max-height: 300px;
				overflow-y: auto;
				margin: 1em 0;
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				padding: 0.5em;
			}
			.callout-item {
				display: flex;
				align-items: flex-start;
				margin-bottom: 0.5em;
				padding: 0.5em;
				border-radius: 4px;
				background: var(--background-secondary);
			}
			.callout-item input[type="checkbox"] {
				margin-right: 0.5em;
				margin-top: 0.2em;
			}
			.callout-label {
				flex: 1;
				cursor: pointer;
				line-height: 1.4;
			}
			.callout-type {
				font-weight: bold;
				color: var(--text-accent);
			}
			.callout-content {
				color: var(--text-muted);
			}
			.callout-buttons {
				display: flex;
				gap: 0.5em;
				margin-bottom: 1em;
			}
			.modal-button-container {
				display: flex;
				justify-content: flex-end;
				gap: 0.5em;
				margin-top: 1em;
			}
		`;
	}

	override onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class UploadProgressModal extends Modal {
	private progressBar!: HTMLElement;
	private progressText!: HTMLElement;
	private stepText!: HTMLElement;
	private currentProgress: number = 0;
	private currentStep: string = '';
	private isCompleted: boolean = false;
	private fakeProgressTimer: NodeJS.Timeout | null = null;
	private lastRealProgress: number = 0;
	private maxFakeProgress: number = 85; // 伪进度最大值

	constructor(app: App) {
		super(app);
	}

	override onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('feishu-upload-progress-modal');

		// 设置模态框样式
		contentEl.style.cssText = `
			padding: 30px;
			text-align: center;
			min-width: 400px;
			border-radius: 8px;
		`;

		// 标题
		const title = contentEl.createEl('h2', { text: '正在上传文档' });
		title.style.cssText = `
			margin-bottom: 20px;
			color: var(--text-normal);
			font-size: 18px;
		`;

		// 步骤提示
		this.stepText = contentEl.createEl('div', { text: '准备上传...' });
		this.stepText.style.cssText = `
			margin-bottom: 20px;
			color: var(--text-muted);
			font-size: 14px;
		`;

		// 进度条容器
		const progressContainer = contentEl.createDiv('progress-container');
		progressContainer.style.cssText = `
			width: 100%;
			height: 8px;
			background: var(--background-modifier-border);
			border-radius: 4px;
			overflow: hidden;
			margin-bottom: 15px;
		`;

		// 进度条
		this.progressBar = progressContainer.createDiv('progress-bar');
		this.progressBar.style.cssText = `
			height: 100%;
			background: linear-gradient(90deg, var(--interactive-accent), var(--interactive-accent-hover));
			width: 0%;
			transition: width 0.3s ease;
			border-radius: 4px;
		`;

		// 进度百分比
		this.progressText = contentEl.createEl('div', { text: '0%' });
		this.progressText.style.cssText = `
			color: var(--text-muted);
			font-size: 12px;
			margin-bottom: 20px;
		`;

		// 提示文本
		const hintText = contentEl.createEl('div', { text: '请保持网络连接，不要关闭此窗口' });
		hintText.style.cssText = `
			color: var(--text-muted);
			font-size: 12px;
			font-style: italic;
		`;
		
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
			this.progressBar.style.width = `${this.currentProgress}%`;
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
			this.stepText.style.color = 'var(--text-error)';
		}

		if (this.progressBar) {
			this.progressBar.style.background = 'var(--text-error)';
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
		contentEl.addClass('user-agreement-modal');

		// 标题
		contentEl.createEl('h2', { text: 'ObShare 用户协议' });

		// 协议内容容器（可滚动）
		const agreementContainer = contentEl.createDiv({ cls: 'agreement-content' });
		agreementContainer.style.maxHeight = '500px';
		agreementContainer.style.overflowY = 'auto';
		agreementContainer.style.padding = '15px';
		agreementContainer.style.border = '1px solid var(--background-modifier-border)';
		agreementContainer.style.borderRadius = '5px';
		agreementContainer.style.marginBottom = '20px';
		agreementContainer.style.width = '100%';
		agreementContainer.style.boxSizing = 'border-box';

		// 协议内容（Markdown格式）
		const agreementText = `欢迎使用ObShare（以下简称"本插件"）。在使用本插件之前，请您仔细阅读并理解以下条款。使用本插件即视为您已同意并遵守本协议。

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
		MarkdownRenderer.renderMarkdown(agreementText, agreementContainer, '', this.component);

		// 按钮容器
		const buttonContainer = contentEl.createDiv({ cls: 'agreement-buttons' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '10px';

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
		agreeButton.onclick = async () => {
			// 保存用户同意状态
			this.plugin.settings.agreedToTerms = true;
			await this.plugin.saveSettings();
			
			// 完成插件初始化
			this.plugin.completeInitialization();
			
			this.close();
			new Notice('欢迎使用 ObShare！', 3000);
		};
	}

	override onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}