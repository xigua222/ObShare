import { Platform } from 'obsidian';

// 使用Web Crypto API替代Node.js crypto模块

/**
 * 加密工具类 - 提供透明的数据加密/解密功能
 * 基于设备特征生成固定密钥，用户无感知
 */
type SensitiveFieldName = 'appId' | 'appSecret' | 'folderToken' | 'userId';
type SensitiveSettings = Partial<Record<SensitiveFieldName, string>> & object;
type EncryptedFieldMap = Partial<Record<SensitiveFieldName, string>>;
type DebugDetails = Record<string, unknown>;

export class CryptoUtils {
    // 加密算法配置
    private static readonly ALGORITHM = 'AES-GCM';
    private static readonly KEY_LENGTH = 256; // 256 bits
    private static readonly IV_LENGTH = 12;   // 96 bits for GCM

    // 敏感字段列表
    private static readonly SENSITIVE_FIELDS: SensitiveFieldName[] = ['appId', 'appSecret', 'folderToken', 'userId'];

    // 缓存机制
    private static encryptionKey: CryptoKey | null = null;
    private static lastEncryptedData: string | null = null;
    private static lastEncryptedResult: string | EncryptedFieldMap | null = null;
    private static debugEnabled = false;

    static setDebugEnabled(enabled: boolean): void {
        this.debugEnabled = enabled;
    }

    private static debug(...args: unknown[]): void {
        if (this.debugEnabled) {
            console.debug(...args);
        }
    }

    private static logError(summary: string, error: unknown, details?: DebugDetails): void {
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
     * 获取缓存的加密密钥，如果不存在则生成新的
     */
    private static async getEncryptionKey(): Promise<CryptoKey> {
        if (this.encryptionKey) {
            return this.encryptionKey;
        }
        this.encryptionKey = await this.generateDeviceKey();
        return this.encryptionKey;
    }

    /**
     * 生成基于设备特征的固定密钥
     * 使用设备的硬件和系统信息生成唯一且稳定的密钥
     */
    private static async generateDeviceKey(): Promise<CryptoKey> {
        // 收集设备特征信息
        const platformLabel = Platform.isMacOS
            ? 'macos'
            : Platform.isWin
            ? 'windows'
            : Platform.isLinux
            ? 'linux'
            : Platform.isMobile
            ? 'mobile'
            : 'unknown';

        const deviceInfo = [
            `platform:${platformLabel}`,
            `desktop:${Platform.isDesktop}`,
            `mobile:${Platform.isMobile}`,
            `app:${Platform.isDesktopApp ? 'desktop' : Platform.isMobileApp ? 'mobile' : 'web'}`,
            navigator.language,
            screen.width + 'x' + screen.height,
            new Date().getTimezoneOffset().toString(),
            window.location.hostname || 'obsidian',
            'feishu-plugin-v1'
        ].join('|');
        
        // 使用TextEncoder将字符串转换为Uint8Array
        const encoder = new TextEncoder();
        const data = encoder.encode(deviceInfo);
        
        // 使用Web Crypto API生成哈希
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        
        // 导入为CryptoKey
        return await crypto.subtle.importKey(
            'raw',
            hashBuffer,
            { name: this.ALGORITHM },
            false,
            ['encrypt', 'decrypt']
        );
    }
    
    /**
     * 加密敏感字符串
     * @param plaintext 明文字符串
     * @returns 加密后的字符串（Base64编码）
     */
    static async encrypt(plaintext: string): Promise<string> {
        if (!plaintext || plaintext.trim() === '') {
            return plaintext; // 空字符串不加密
        }
        
        // 检查缓存
        if (this.lastEncryptedData === plaintext && typeof this.lastEncryptedResult === 'string') {
            return this.lastEncryptedResult;
        }
        
        try {
            const key = await this.getEncryptionKey();
            const iv = crypto.getRandomValues(new Uint8Array(this.IV_LENGTH));
            
            const encoder = new TextEncoder();
            const data = encoder.encode(plaintext);
            
            const encrypted = await crypto.subtle.encrypt(
                {
                    name: this.ALGORITHM,
                    iv: iv
                },
                key,
                data
            );
            
            // 组合: IV + 加密数据
            const combined = new Uint8Array(iv.length + encrypted.byteLength);
            combined.set(iv);
            combined.set(new Uint8Array(encrypted), iv.length);
            
            // 转换为Base64
            const result = this.arrayBufferToBase64(combined.buffer);
            
            // 缓存结果
            this.lastEncryptedData = plaintext;
            this.lastEncryptedResult = result;
            
            return result;
        } catch (error) {
            this.logError('[加密工具] 加密失败:', error);
            return plaintext; // 加密失败时返回原文
        }
    }
    
    /**
     * 解密敏感字符串
     * @param encryptedData 加密的字符串（Base64编码）
     * @returns 解密后的明文字符串
     */
    static async decrypt(encryptedData: string): Promise<string> {
        if (!encryptedData || encryptedData.trim() === '') {
            return encryptedData; // 空字符串不解密
        }
        
        // 检查是否为加密数据（简单判断Base64格式）
        if (!this.isEncryptedData(encryptedData)) {
            return encryptedData; // 非加密数据直接返回
        }
        
        try {
            const key = await this.getEncryptionKey();
            const combined = this.base64ToArrayBuffer(encryptedData);
            const combinedArray = new Uint8Array(combined);
            
            // 分离: IV + 加密数据
            const iv = combinedArray.slice(0, this.IV_LENGTH);
            const encrypted = combinedArray.slice(this.IV_LENGTH);
            
            const decrypted = await crypto.subtle.decrypt(
                {
                    name: this.ALGORITHM,
                    iv: iv
                },
                key,
                encrypted
            );
            
            const decoder = new TextDecoder();
            return decoder.decode(decrypted);
        } catch (error) {
            this.logError('[加密工具] 解密失败:', error);
            return encryptedData; // 解密失败时返回原数据
        }
    }
    
    /**
	 * 判断字符串是否为加密数据
	 * @param data 待检查的字符串
	 * @returns 是否为加密数据
	 */
	static isEncryptedData(data: string): boolean {
        // 简单的Base64格式检查
        const base64Regex = /^[A-Za-z0-9+/]+=*$/;
        if (!base64Regex.test(data)) {
            return false;
        }
        
        try {
            const decoded = this.base64ToArrayBuffer(data);
            // 加密数据应该至少包含 IV + 一些加密内容
            return decoded.byteLength >= (this.IV_LENGTH + 1);
        } catch {
            return false;
        }
    }
    
    /**
     * ArrayBuffer转Base64
     */
    private static arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            const byte = bytes[i];
            if (byte !== undefined) {
                binary += String.fromCharCode(byte);
            }
        }
        return btoa(binary);
    }
    
    /**
     * Base64转ArrayBuffer
     */
    private static base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }
    
    /**
     * 加密敏感设置对象（带缓存优化）
     * @param settings 设置对象
     * @returns 加密后的设置对象
     */
    static async encryptSensitiveSettings<T extends SensitiveSettings>(settings: T): Promise<T> {
        // 检查敏感字段是否有变化
        const sensitiveData = this.extractSensitiveData(settings);
        const sensitiveDataString = JSON.stringify(sensitiveData);
        
        const encrypted = { ...settings };
        const cachedEncryptedFields = this.lastEncryptedResult;
        // 如果敏感数据没有变化，直接返回缓存的结果
        if (this.lastEncryptedData === sensitiveDataString && cachedEncryptedFields && typeof cachedEncryptedFields === 'object' && !Array.isArray(cachedEncryptedFields)) {
            return Object.assign(encrypted, cachedEncryptedFields);
        }
        
        const encryptedFields: EncryptedFieldMap = {};
        
        for (const field of this.SENSITIVE_FIELDS) {
            if (encrypted[field] && typeof encrypted[field] === 'string') {
                encryptedFields[field] = await CryptoUtils.encrypt(encrypted[field]);
                encrypted[field] = encryptedFields[field];
            }
        }
        
        // 缓存加密结果
        this.lastEncryptedData = sensitiveDataString;
        this.lastEncryptedResult = encryptedFields;
        
        return encrypted;
    }
    
    /**
     * 提取敏感数据用于缓存比较
     */
    private static extractSensitiveData(settings: SensitiveSettings): EncryptedFieldMap {
        const sensitiveData: EncryptedFieldMap = {};
        for (const field of this.SENSITIVE_FIELDS) {
            if (settings[field]) {
                sensitiveData[field] = settings[field];
            }
        }
        return sensitiveData;
    }
    
    /**
     * 解密敏感设置对象（带缓存优化）
     * @param settings 加密的设置对象
     * @returns 解密后的设置对象
     */
    static async decryptSensitiveSettings<T extends SensitiveSettings>(settings: T): Promise<T> {
        const result = { ...settings };
        let hasEncryptedData = false;
        
        for (const field of this.SENSITIVE_FIELDS) {
            if (settings[field] && typeof settings[field] === 'string') {
                try {
                    // 检查是否是加密数据
                    if (this.isEncryptedData(settings[field])) {
                        result[field] = await this.decrypt(settings[field]);
                        hasEncryptedData = true;
                    } else {
                        // 未加密的数据，保持原值
                        result[field] = settings[field];
                    }
                } catch (error) {
                    // 如果解密失败，可能是未加密的数据，保持原值
                    console.warn(`[加密工具] 字段 ${field} 解密失败，可能是未加密数据:`, error);
                    result[field] = settings[field];
                }
            }
        }
        
        // 如果没有加密数据，清空缓存以避免混淆
        if (!hasEncryptedData) {
            this.clearCache();
        }
        
        return result;
    }
    
    /**
     * 清空缓存
     */
    static clearCache(): void {
        this.lastEncryptedData = null;
        this.lastEncryptedResult = null;
    }
}
