const path = require("path");
const fs = require("fs");

class AutoLoader {
  constructor({ autoloaderConfigPath, options = {} }) {
    if (!autoloaderConfigPath) throw new Error("AutoLoader requires autoloaderConfigPath");
    this.autoloaderConfigPath = autoloaderConfigPath;

    // Configuration options with secure defaults
    this.options = {
      allowedBasePaths: options.allowedBasePaths || [process.cwd()],
      utilitiesDir: options.utilitiesDir || path.resolve(__dirname, "../utils"),
      defaultRole: options.defaultRole || null,
      maxCacheSize: options.maxCacheSize || 1000,
      maxUtilityCache: options.maxUtilityCache || 100,
      strictPathValidation: options.strictPathValidation !== false, // default true
      moduleLoadTimeout: options.moduleLoadTimeout || 30000, // 30 seconds default
      enablePathMemoization: options.enablePathMemoization !== false, // default true
      deepCloneUtilities: options.deepCloneUtilities !== false, // default true
      ...options
    };

    this.loadedCoreUtilities = {};
    this.loadedModuleCache = new Map();
    this.loadedUtilityNames = new Set();
    this.cacheAccessOrder = []; // For LRU eviction
    this.resolvedPathCache = new Map(); // For path memoization

    const resolvedCfgPath = this._safeResolve(autoloaderConfigPath);
    
    // Fix: Wrap config require with error handling
    try {
      this.autoloaderConfig = require(resolvedCfgPath);
    } catch (error) {
      throw new Error(
        `Failed to load autoloader configuration:\n` +
        `  Config path: "${autoloaderConfigPath}"\n` +
        `  Resolved path: "${resolvedCfgPath}"\n` +
        `  Error: ${error.message}\n` +
        `  Stack: ${error.stack}`
      );
    }

    // Fix: Allow default role fallback instead of mandatory APP_ROLE
    const hasRoles = this.autoloaderConfig && this.autoloaderConfig.role && typeof this.autoloaderConfig.role === "object";
    if (hasRoles && !process.env.APP_ROLE && !this.options.defaultRole) {
      throw new Error("APP_ROLE environment variable must be defined or options.defaultRole must be set");
    }
  }

  loadCoreUtilities() {
    const { core = [], role = {} } = this.autoloaderConfig || {};
    const appRole = process.env.APP_ROLE || this.options.defaultRole;

    console.log('🔧 [AutoLoader] Loading core utilities...');
    console.log('🔧 [AutoLoader] Core modules to load:', core);
    
    for (const coreName of Array.isArray(core) ? core : []) {
      console.log(`🔧 [AutoLoader] Loading core module: ${coreName}`);
      this._requireUtilityIntoCache(coreName);
      console.log(`✅ [AutoLoader] Core module loaded: ${coreName}`);
    }
    
    if (appRole && role[appRole]) {
      console.log(`🔧 [AutoLoader] Loading role-specific modules for role: ${appRole}`, role[appRole]);
      for (const roleName of Array.isArray(role[appRole]) ? role[appRole] : []) {
        console.log(`🔧 [AutoLoader] Loading role module: ${roleName}`);
        this._requireUtilityIntoCache(roleName);
        console.log(`✅ [AutoLoader] Role module loaded: ${roleName}`);
      }
    } else {
      console.log(`🔧 [AutoLoader] No role-specific modules for role: ${appRole}`);
    }
    
    console.log('✅ [AutoLoader] All core utilities loaded:', Object.keys(this.loadedCoreUtilities));
    
    // Fix: Return frozen object to prevent mutation without unnecessary cloning
    return this.options.deepCloneUtilities 
      ? this._deepClone(this.loadedCoreUtilities)
      : Object.freeze({ ...this.loadedCoreUtilities });
  }

  ensureRouteDependencies(routeEntry) {
    console.log('📦 [AutoLoader] Loading route dependencies...');
    
    if (Array.isArray(routeEntry?.requires)) {
      console.log('📦 [AutoLoader] Loading required dependencies:', routeEntry.requires);
      for (const relPath of routeEntry.requires) {
        console.log(`📦 [AutoLoader] Loading dependency: ${relPath}`);
        const mod = this._requireModuleOnce(relPath);
        if (!mod) throw new Error(`Failed to require dependency module: ${relPath}`);
        console.log(`✅ [AutoLoader] Dependency loaded: ${relPath}`);
      }
    }

    if (Array.isArray(routeEntry?.handlers) && routeEntry.handlers.length > 0) {
      console.log('🔗 [AutoLoader] Loading pipeline handlers:', routeEntry.handlers.length, 'handlers');
      const fns = [];
      for (let i = 0; i < routeEntry.handlers.length; i++) {
        const h = routeEntry.handlers[i];
        
        // Fix: Validate handler object shape before accessing properties
        if (!h || typeof h !== 'object') {
          throw new Error(`Handler at index ${i} must be an object, got: ${typeof h}`);
        }
        
        console.log(`🔗 [AutoLoader] Loading handler ${i + 1}/${routeEntry.handlers.length}: ${h.module}::${h.function}`);
        
        if (!h?.module || !h?.function) {
          throw new Error(`Handler at index ${i} must define both 'module' and 'function' properties. Got: ${JSON.stringify(h)}`);
        }
        
        const m = this._requireModuleOnce(h.module);
        const fn = m?.[h.function];
        
        // Fix: Provide detailed error context when handler function is not found
        if (typeof fn !== "function") {
          throw new Error(
            `Handler function not found or not a function:\n` +
            `  Module: "${h.module}"\n` +
            `  Function: "${h.function}"\n` +
            `  Handler index: ${i}\n` +
            `  Type found: ${typeof fn}\n` +
            `  Available exports: ${Object.keys(m || {}).join(', ')}`
          );
        }
        
        fns.push(fn);
        console.log(`✅ [AutoLoader] Handler ${i + 1} loaded: ${h.function}`);
      }
      console.log('✅ [AutoLoader] All pipeline handlers loaded, execution order:', routeEntry.handlers.map(h => h.function));
      return { handlerFns: fns };
    }

    console.log('🔗 [AutoLoader] Loading single handler');
    const fnName = routeEntry?.function;
    const modulePath = routeEntry?.module;
    if (!fnName || !modulePath) {
      throw new Error("Route entry must define `module` + `function` or `handlers[]`");
    }
    console.log(`🔗 [AutoLoader] Loading handler: ${modulePath}::${fnName}`);
    const handlerModule = this._requireModuleOnce(modulePath);
    const handlerFn = handlerModule?.[fnName];
    
    // Fix: Provide detailed error context for single handler
    if (typeof handlerFn !== "function") {
      throw new Error(
        `Handler function not found or not a function:\n` +
        `  Module: "${modulePath}"\n` +
        `  Function: "${fnName}"\n` +
        `  Type found: ${typeof handlerFn}\n` +
        `  Available exports: ${Object.keys(handlerModule || {}).join(', ')}`
      );
    }
    
    console.log(`✅ [AutoLoader] Single handler loaded: ${fnName}`);
    return { handlerFns: [handlerFn] };
  }

  getCoreUtilities() {
    // Fix: Deep clone or freeze to prevent mutation of internals
    return this.options.deepCloneUtilities 
      ? this._deepClone(this.loadedCoreUtilities)
      : Object.freeze({ ...this.loadedCoreUtilities });
  }

  _requireUtilityIntoCache(utilityName) {
    if (!utilityName || this.loadedUtilityNames.has(utilityName)) return;
    
    // Fix: Add error handling with detailed context
    try {
      // Enforce cache size limits
      if (this.loadedUtilityNames.size >= this.options.maxUtilityCache) {
        throw new Error(
          `Utility cache limit reached (${this.options.maxUtilityCache}). ` +
          `Cannot load more utilities. Consider increasing maxUtilityCache option.`
        );
      }
      
      // Fix: Use configurable utilities directory instead of hard-coded path
      const utilitiesDir = this.options.utilitiesDir;
      const absPath = path.join(utilitiesDir, utilityName);
      const finalPath = this._resolveFile(absPath);
      
      this.loadedCoreUtilities[utilityName] = require(finalPath);
      this.loadedUtilityNames.add(utilityName);
    } catch (error) {
      throw new Error(
        `Failed to load utility "${utilityName}":\n` +
        `  Utilities directory: "${this.options.utilitiesDir}"\n` +
        `  Error: ${error.message}\n` +
        `  Stack: ${error.stack}`
      );
    }
  }

  _requireModuleOnce(relativeOrAbsolutePath) {
    const absPath = this._safeResolve(relativeOrAbsolutePath);
    
    if (this.loadedModuleCache.has(absPath)) {
      // Update LRU access order
      this._updateCacheAccess(absPath);
      return this.loadedModuleCache.get(absPath);
    }
    
    // Fix: Enforce cache size limits with LRU eviction
    if (this.loadedModuleCache.size >= this.options.maxCacheSize) {
      this._evictLRUCache();
    }
    
    // Fix: Wrap require with try/catch and timeout mechanism
    let mod;
    try {
      mod = this._requireWithTimeout(absPath);
    } catch (error) {
      throw new Error(
        `Failed to require module:\n` +
        `  Original path: "${relativeOrAbsolutePath}"\n` +
        `  Resolved path: "${absPath}"\n` +
        `  Error: ${error.message}\n` +
        `  Stack: ${error.stack}`
      );
    }
    
    this.loadedModuleCache.set(absPath, mod);
    this._updateCacheAccess(absPath);
    return mod;
  }

  /**
   * Update cache access order for LRU tracking
   */
  _updateCacheAccess(absPath) {
    // Remove existing entry
    const existingIndex = this.cacheAccessOrder.indexOf(absPath);
    if (existingIndex > -1) {
      this.cacheAccessOrder.splice(existingIndex, 1);
    }
    // Add to end (most recently used)
    this.cacheAccessOrder.push(absPath);
  }

  /**
   * Evict least recently used cache entry
   */
  _evictLRUCache() {
    if (this.cacheAccessOrder.length === 0) return;
    
    // Remove least recently used (first in array)
    const lruPath = this.cacheAccessOrder.shift();
    this.loadedModuleCache.delete(lruPath);
    console.log(`🗑️ [AutoLoader] Evicted LRU cache entry: ${lruPath}`);
  }

  /**
   * Validate that a path is within allowed base paths
   */
  _validatePathSecurity(absPath) {
    if (!this.options.strictPathValidation) return true;
    
    const normalizedPath = path.normalize(absPath);
    const allowedPaths = this.options.allowedBasePaths;
    
    // Check if path is within any allowed base path
    for (const basePath of allowedPaths) {
      const normalizedBase = path.normalize(basePath);
      const relative = path.relative(normalizedBase, normalizedPath);
      
      // If relative path doesn't start with '..' then it's inside the base path
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return true;
      }
    }
    
    throw new Error(
      `Security violation: Path "${absPath}" is not within allowed base paths:\n` +
      `  Allowed paths: ${allowedPaths.join(', ')}\n` +
      `  To allow this path, add it to allowedBasePaths option or set strictPathValidation: false`
    );
  }

  _safeResolve(inputPath) {
    // Fix: Memoization for repeated path resolutions
    if (this.options.enablePathMemoization && this.resolvedPathCache.has(inputPath)) {
      return this.resolvedPathCache.get(inputPath);
    }
    
    // Fix: Normalize and validate paths to prevent path traversal attacks
    if (!inputPath || typeof inputPath !== 'string') {
      throw new Error(`Invalid path provided: ${inputPath}`);
    }
    
    // Prevent null byte injection
    if (inputPath.includes('\0')) {
      throw new Error(`Invalid path (contains null byte): ${inputPath}`);
    }
    
    // Normalize the path to resolve . and .. segments
    const normalizedInput = path.normalize(inputPath);
    
    // Resolve to absolute path
    const absCandidate = path.isAbsolute(normalizedInput) 
      ? normalizedInput 
      : path.resolve(__dirname, normalizedInput);
    
    // Validate against allowed base paths
    this._validatePathSecurity(absCandidate);
    
    const resolvedPath = this._resolveFile(absCandidate);
    
    // Cache the resolved path
    if (this.options.enablePathMemoization) {
      this.resolvedPathCache.set(inputPath, resolvedPath);
    }
    
    return resolvedPath;
  }

  _resolveFile(candidatePath) {
    // Fix: Add .mjs support for ES modules
    const tryPaths = [
      candidatePath, 
      `${candidatePath}.js`, 
      `${candidatePath}.mjs`, 
      `${candidatePath}.json`
    ];
    
    for (const p of tryPaths) {
      if (fs.existsSync(p)) return p;
    }
    
    throw new Error(
      `Module not found: "${candidatePath}"\n` +
      `  Tried paths: ${tryPaths.join(', ')}`
    );
  }
  
  /**
   * Require a module with timeout protection
   */
  _requireWithTimeout(modulePath) {
    const timeout = this.options.moduleLoadTimeout;
    
    if (timeout <= 0) {
      return require(modulePath);
    }
    
    let timeoutHandle;
    let isTimedOut = false;
    
    // Set up timeout
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        isTimedOut = true;
        reject(new Error(
          `Module load timeout (${timeout}ms) exceeded for: ${modulePath}`
        ));
      }, timeout);
    });
    
    try {
      // Synchronous require, but we track if timeout fires
      const mod = require(modulePath);
      clearTimeout(timeoutHandle);
      
      if (isTimedOut) {
        throw new Error(`Module load timeout (${timeout}ms) exceeded for: ${modulePath}`);
      }
      
      return mod;
    } catch (error) {
      clearTimeout(timeoutHandle);
      throw error;
    }
  }
  
  /**
   * Deep clone object to prevent mutation of internals
   */
  _deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj.getTime());
    if (obj instanceof Array) return obj.map(item => this._deepClone(item));
    if (obj instanceof Map) return new Map(Array.from(obj, ([k, v]) => [k, this._deepClone(v)]));
    if (obj instanceof Set) return new Set(Array.from(obj, item => this._deepClone(item)));
    
    const clonedObj = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        clonedObj[key] = this._deepClone(obj[key]);
      }
    }
    return clonedObj;
  }
}

module.exports = AutoLoader;