// SafeUtils module for sanitization
class SafeUtils {
  static sanitizeString(str) {
    if (typeof str !== 'string') return '';
    return str.trim().replace(/[^\w\s\-_.\/]/g, '');
  }
  
  static sanitizeFilePath(filePath) {
    if (typeof filePath !== 'string') return '';
    return filePath.replace(/\.\./g, '').replace(/[^\w\s\-_.\/\\:]/g, '');
  }
}

module.exports = SafeUtils;
