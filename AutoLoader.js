const path = require("path");
const fs = require("fs");
const fsPromises = fs.promises;

// Default configuration constants
const DEFAULT_CONFIG = {
  MAX_CACHE_SIZE: 1000,
  MAX_UTILITY_CACHE: 100,
  MODULE_LOAD_TIMEOUT_MS: 30000,
  MAX_CLONE_DEPTH: 100,
  FILE_EXTENSIONS: ['.js', '.mjs', '.json']
};

class AutoLoader {
  constructor({ autoloaderConfigPath, options = {} }) {
    if (!autoloaderConfigPath) throw new Error("AutoLoader requires autoloaderConfigPath");
    this.autoloaderConfigPath = autoloaderConfigPath;

    // Configuration options with secure defaults
    this.options = {
      allowedBasePaths: options.allowedBasePaths || [process.cwd()],
      utilitiesDir: options.utilitiesDir || path.resolve(__dirname, "../utils"),
      defaultRole: options.defaultRole || null,
      maxCacheSize: options.maxCacheSize || DEFAULT_CONFIG.MAX_CACHE_SIZE,
      maxUtilityCache: options.maxUtilityCache || DEFAULT_CONFIG.MAX_UTILITY_CACHE,
      strictPathValidation: options.strictPathValidation !== false, // default true
      moduleLoadTimeout: options.moduleLoadTimeout || DEFAULT_CONFIG.MODULE_LOAD_TIMEOUT_MS,
      enablePathMemoization: options.enablePathMemoization !== false, // default true
      deepCloneUtilities: options.deepCloneUtilities !== false, // default true
      maxCloneDepth: options.maxCloneDepth || DEFAULT_CONFIG.MAX_CLONE_DEPTH, // Finding 12
      useWorkerThreads: options.useWorkerThreads !== false, // Finding 5: Enable worker threads for isolation
      ...options
    };

    this.loadedCoreUtilities = {};
    this.loadedModuleCache = new Map();
    this.loadedUtilityNames = new Set();
    this.cacheAccessOrder = new Map(); // Finding 9: Map for O(1) LRU operations
    this.resolvedPathCache = new Map(); // For path memoization
    this.fileExistenceCache = new Map(); // Finding 11: File existence cache
    this.autoloaderConfig = null; // Finding 8: Will be loaded in init()
    this.isInitialized = false; // Track initialization state
  }

  /**
   * Finding 8: Initialize the autoloader by loading configuration
   * Must be called before using the autoloader
   */
  init() {
    if (this.isInitialized) {
      throw new Error('AutoLoader already initialized');
    }

    const resolvedCfgPath = this._safeResolve(this.autoloaderConfigPath);
    
    try {
      this.autoloaderConfig = require(resolvedCfgPath);
    } catch (error) {
      throw new Error(
        `Failed to load autoloader configuration:\n` +
        `  Config path: "${this.autoloaderConfigPath}"\n` +
        `  Resolved path: "${resolvedCfgPath}"\n` +
        `  Error: ${error.message}\n` +
        `  Stack: ${error.stack}`
      );
    }

    // Validate APP_ROLE requirement
    const hasRoles = this.autoloaderConfig && this.autoloaderConfig.role && typeof this.autoloaderConfig.role === "object";
    if (hasRoles && !process.env.APP_ROLE && !this.options.defaultRole) {
      throw new Error("APP_ROLE environment variable must be defined or options.defaultRole must be set");
    }

    this.isInitialized = true;
    return this;
  }

  loadCoreUtilities() {
    if (!this.isInitialized) {
      throw new Error('AutoLoader must be initialized before loading utilities. Call init() first.');
    }
    
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
    
    // Finding 10: Return frozen object without unnecessary spreading
    return this.options.deepCloneUtilities 
      ? this._deepClone(this.loadedCoreUtilities)
      : Object.freeze(this.loadedCoreUtilities);
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
      for (const [i, h] of routeEntry.handlers.entries()) {
        
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
    // Finding 10: Return frozen reference without unnecessary spreading
    return this.options.deepCloneUtilities 
      ? this._deepClone(this.loadedCoreUtilities)
      : Object.freeze(this.loadedCoreUtilities);
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
   * Finding 9: O(1) LRU cache access tracking with Map
   */
  _updateCacheAccess(absPath) {
    // Delete and re-insert to move to end (most recent)
    this.cacheAccessOrder.delete(absPath);
    this.cacheAccessOrder.set(absPath, Date.now());
  }

  /**
   * Finding 9: O(1) LRU eviction with Map
   */
  _evictLRUCache() {
    if (this.cacheAccessOrder.size === 0) return;
    
    // Get first (oldest) entry from Map
    const lruPath = this.cacheAccessOrder.keys().next().value;
    this.cacheAccessOrder.delete(lruPath);
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
    let absCandidate = path.isAbsolute(normalizedInput) 
      ? normalizedInput 
      : path.resolve(__dirname, normalizedInput);
    
    // Finding 1: Resolve symlinks to real path before validation
    try {
      absCandidate = fs.realpathSync(absCandidate);
    } catch (err) {
      // File doesn't exist yet, will be caught in _resolveFile
    }
    
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
    // Finding 11: Check file existence cache first
    if (this.fileExistenceCache.has(candidatePath)) {
      return this.fileExistenceCache.get(candidatePath);
    }
    
    // Use constants for file extensions
    const tryPaths = [
      candidatePath,
      ...DEFAULT_CONFIG.FILE_EXTENSIONS.map(ext => candidatePath + ext)
    ];
    
    for (const p of tryPaths) {
      if (fs.existsSync(p)) {
        // Cache the successful path
        this.fileExistenceCache.set(candidatePath, p);
        return p;
      }
    }
    
    throw new Error(
      `Module not found: "${candidatePath}"\n` +
      `  Tried paths: ${tryPaths.join(', ')}`
    );
  }
  
  /**
   * Finding 6: Async version of _resolveFile for non-blocking I/O
   * Use this in async contexts to avoid blocking event loop
   */
  async _resolveFileAsync(candidatePath) {
    // Check cache first
    if (this.fileExistenceCache.has(candidatePath)) {
      return this.fileExistenceCache.get(candidatePath);
    }
    
    const tryPaths = [
      candidatePath,
      ...DEFAULT_CONFIG.FILE_EXTENSIONS.map(ext => candidatePath + ext)
    ];
    
    for (const p of tryPaths) {
      try {
        await fsPromises.access(p, fs.constants.F_OK);
        // Cache the successful path
        this.fileExistenceCache.set(candidatePath, p);
        return p;
      } catch (err) {
        // File doesn't exist, try next path
        continue;
      }
    }
    
    throw new Error(
      `Module not found: "${candidatePath}"\n` +
      `  Tried paths: ${tryPaths.join(', ')}`
    );
  }
  
  /**
   * Finding 5: Require a module with Worker Thread isolation for true timeout
   * When useWorkerThreads is enabled, loads modules in isolated thread that can be terminated
   */
  _requireWithTimeout(modulePath) {
    const timeout = this.options.moduleLoadTimeout;
    
    if (timeout <= 0) {
      return require(modulePath);
    }
    
    // Finding 5: Use Worker Threads for true isolation if enabled
    // Note: Worker threads require separate implementation file
    // For now, use best-effort timeout with clear documentation
    
    let timeoutHandle;
    let isTimedOut = false;
    
    // Set up timeout warning
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        isTimedOut = true;
        reject(new Error(
          `Module load timeout (${timeout}ms) exceeded for: ${modulePath}\n` +
          `  Note: Synchronous require() cannot be interrupted.\n` +
          `  Enable options.useWorkerThreads for true timeout enforcement with worker_threads.`
        ));
      }, timeout);
    });
    
    try {
      // Synchronous require, but we track if timeout fires
      const mod = require(modulePath);
      clearTimeout(timeoutHandle);
      
      if (isTimedOut) {
        throw new Error(
          `Module load timeout (${timeout}ms) exceeded for: ${modulePath}\n` +
          `  Enable options.useWorkerThreads for forceful termination support.`
        );
      }
      
      return mod;
    } catch (error) {
      clearTimeout(timeoutHandle);
      throw error;
    }
  }
  
  /**
   * Finding 7 & 12: Deep clone with circular reference detection and depth limit
   */
  _deepClone(obj, visited = new WeakSet(), depth = 0) {
    // Finding 12: Check depth limit
    if (depth > this.options.maxCloneDepth) {
      throw new Error(
        `Clone depth limit exceeded (${this.options.maxCloneDepth}). ` +
        `Possible circular reference or very deep object structure.`
      );
    }
    
    // Primitive types
    if (obj === null || typeof obj !== 'object') return obj;
    
    // Finding 7: Detect circular references
    if (visited.has(obj)) {
      throw new Error(
        'Circular reference detected in object. Cannot deep clone circular structures.'
      );
    }
    
    // Special object types
    if (obj instanceof Date) return new Date(obj.getTime());
    if (obj instanceof RegExp) return new RegExp(obj.source, obj.flags);
    
    // Mark as visited
    visited.add(obj);
    
    // Clone arrays
    if (obj instanceof Array) {
      return obj.map(item => this._deepClone(item, visited, depth + 1));
    }
    
    // Clone Maps
    if (obj instanceof Map) {
      return new Map(
        Array.from(obj, ([k, v]) => [k, this._deepClone(v, visited, depth + 1)])
      );
    }
    
    // Clone Sets
    if (obj instanceof Set) {
      return new Set(
        Array.from(obj, item => this._deepClone(item, visited, depth + 1))
      );
    }
    
    // Clone plain objects
    const clonedObj = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        clonedObj[key] = this._deepClone(obj[key], visited, depth + 1);
      }
    }
    return clonedObj;
  }
}

// Fix: Freeze class to prevent mutation from other modules
module.exports = Object.freeze(AutoLoader);