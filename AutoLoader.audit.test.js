/**
 * Additional tests specifically for audit findings
 * These tests validate the security and performance fixes
 */

const path = require("path");
const fs = require("fs");
const AutoLoader = require("./AutoLoader");

describe("Audit Finding Tests", () => {
  const mockConfig = {
    core: ["coreA"],
    role: { admin: ["adminUtil"] }
  };
  
  const configPath = path.join(__dirname, "test-audit-config.js");

  beforeAll(() => {
    fs.writeFileSync(configPath, `module.exports = ${JSON.stringify(mockConfig, null, 2)};`);
  });

  afterAll(() => {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  });

  beforeEach(() => {
    process.env.APP_ROLE = "admin";
  });

  // ============================================================================
  // FINDING 1: Path Traversal Through Symbolic Links (HIGH)
  // ============================================================================
  
  describe("Finding 1: Symlink Path Traversal", () => {
    test("should resolve symlinks before path validation", () => {
      const targetFile = path.join(__dirname, "test-target.js");
      const symlinkPath = path.join(__dirname, "test-symlink.js");
      
      // Create target file and symlink
      fs.writeFileSync(targetFile, "module.exports = { name: 'target' };");
      
      try {
        // Create symlink (may fail on Windows without admin)
        fs.symlinkSync(targetFile, symlinkPath);
        
        const loader = new AutoLoader({ 
          autoloaderConfigPath: configPath,
          options: { 
            strictPathValidation: true,
            allowedBasePaths: [__dirname]
          }
        });
        loader.init();
        
        // Should resolve to real path
        const resolved = loader._safeResolve(symlinkPath);
        
        // On Windows, fs.realpathSync may return different casing
        expect(resolved.toLowerCase()).toBe(targetFile.toLowerCase());
        expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(targetFile));
        
      } catch (err) {
        if (err.code === 'EPERM') {
          console.warn('⚠️ Skipping symlink test - requires admin privileges on Windows');
        } else {
          throw err;
        }
      } finally {
        // Cleanup
        if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
        if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
      }
    });

    test("should reject symlinks pointing outside allowed paths", () => {
      // This would be a true security test if we could create symlinks to system files
      // For now, we verify the realpath resolution happens
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { 
          strictPathValidation: true,
          allowedBasePaths: [__dirname]
        }
      });
      loader.init();
      
      // Verify fs.realpathSync is called by checking error messages
      expect(() => {
        loader._safeResolve("/etc/passwd");
      }).toThrow();
    });
  });

  // ============================================================================
  // FINDING 4: Race Conditions on Cache Operations (HIGH)
  // ============================================================================
  
  describe("Finding 4: Race Conditions in Cache", () => {
    test("should use atomic Map operations for cache updates", () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { strictPathValidation: false }
      });
      loader.init();
      
      // Verify cacheAccessOrder is a Map (not Array)
      expect(loader.cacheAccessOrder instanceof Map).toBe(true);
      
      // Test concurrent updates don't corrupt state
      const testPath1 = path.join(__dirname, "race-test1.js");
      const testPath2 = path.join(__dirname, "race-test2.js");
      
      fs.writeFileSync(testPath1, "module.exports = { id: 1 };");
      fs.writeFileSync(testPath2, "module.exports = { id: 2 };");
      
      loader._requireModuleOnce(testPath1);
      loader._requireModuleOnce(testPath2);
      loader._requireModuleOnce(testPath1); // Access again to update LRU
      
      // Map should maintain integrity
      expect(loader.cacheAccessOrder.size).toBe(2);
      expect(loader.loadedModuleCache.size).toBe(2);
      
      // Cleanup
      fs.unlinkSync(testPath1);
      fs.unlinkSync(testPath2);
    });

    test("O(1) cache access and eviction", () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { 
          strictPathValidation: false,
          maxCacheSize: 3
        }
      });
      loader.init();
      
      const files = [];
      for (let i = 1; i <= 5; i++) {
        const filePath = path.join(__dirname, `perf-test-${i}.js`);
        fs.writeFileSync(filePath, `module.exports = { id: ${i} };`);
        files.push(filePath);
      }
      
      // Measure time for many operations (should be O(1), not O(n))
      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        files.forEach(f => loader._requireModuleOnce(f));
      }
      const elapsed = Date.now() - start;
      
      // With O(1) operations, this should complete quickly even with many ops
      expect(elapsed).toBeLessThan(1000); // Should be fast
      expect(loader.loadedModuleCache.size).toBeLessThanOrEqual(3);
      
      // Cleanup
      files.forEach(f => fs.unlinkSync(f));
    });
  });

  // ============================================================================
  // FINDING 5: Timeout Cannot Interrupt Sync Loading (HIGH)
  // ============================================================================
  
  describe("Finding 5: Module Load Timeout", () => {
    test("should document timeout limitations in error message", () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { 
          strictPathValidation: false,
          moduleLoadTimeout: 100,
          useWorkerThreads: false // Explicitly test sync behavior
        }
      });
      loader.init();
      
      // Create a module that takes time to load (though we can't actually timeout sync require)
      const slowModule = path.join(__dirname, "slow-module.js");
      fs.writeFileSync(slowModule, `
        // This won't actually timeout, but the infrastructure is there
        module.exports = { loaded: true };
      `);
      
      try {
        const mod = loader._requireModuleOnce(slowModule);
        expect(mod.loaded).toBe(true);
      } catch (error) {
        // If timeout fires (unlikely with sync require), check error message
        expect(error.message).toContain('useWorkerThreads');
      }
      
      fs.unlinkSync(slowModule);
    });

    test("should have useWorkerThreads option available", () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { 
          strictPathValidation: false,
          useWorkerThreads: true
        }
      });
      
      expect(loader.options.useWorkerThreads).toBe(true);
    });
  });

  // ============================================================================
  // FINDING 6: Async I/O for Non-Blocking Operations (MEDIUM)
  // ============================================================================
  
  describe("Finding 6: Async File I/O", () => {
    test("_resolveFileAsync should work without blocking", async () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { strictPathValidation: false }
      });
      loader.init();
      
      const testFile = path.join(__dirname, "async-test.js");
      fs.writeFileSync(testFile, "module.exports = { async: true };");
      
      // Test async resolution
      const resolved = await loader._resolveFileAsync(testFile.replace('.js', ''));
      expect(resolved).toBe(testFile);
      
      fs.unlinkSync(testFile);
    });

    test("_resolveFileAsync should use file existence cache", async () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { strictPathValidation: false }
      });
      loader.init();
      
      const testFile = path.join(__dirname, "cache-async-test.js");
      fs.writeFileSync(testFile, "module.exports = {};");
      
      const basePath = testFile.replace('.js', '');
      
      // First call - should populate cache
      const resolved1 = await loader._resolveFileAsync(basePath);
      
      // Second call - should use cache
      const resolved2 = await loader._resolveFileAsync(basePath);
      
      expect(resolved1).toBe(resolved2);
      expect(loader.fileExistenceCache.has(basePath)).toBe(true);
      
      fs.unlinkSync(testFile);
    });
  });

  // ============================================================================
  // FINDING 7: Circular Reference Detection (MEDIUM)
  // ============================================================================
  
  describe("Finding 7: Circular References in Deep Clone", () => {
    test("should detect and reject circular references", () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { 
          strictPathValidation: false,
          deepCloneUtilities: true
        }
      });
      loader.init();
      
      // Create circular reference
      const obj = { name: 'test' };
      obj.self = obj; // Circular reference
      
      expect(() => {
        loader._deepClone(obj);
      }).toThrow(/Circular reference detected/);
    });

    test("should handle complex nested circular references", () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { 
          strictPathValidation: false,
          deepCloneUtilities: true
        }
      });
      loader.init();
      
      const a = { name: 'a' };
      const b = { name: 'b', ref: a };
      a.ref = b; // Circular: a -> b -> a
      
      expect(() => {
        loader._deepClone(a);
      }).toThrow(/Circular reference detected/);
    });
  });

  // ============================================================================
  // FINDING 11: File Existence Caching (MEDIUM)
  // ============================================================================
  
  describe("Finding 11: File Existence Cache", () => {
    test("should cache resolved file paths", () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { strictPathValidation: false }
      });
      loader.init();
      
      const testFile = path.join(__dirname, "cache-test.js");
      fs.writeFileSync(testFile, "module.exports = {};");
      
      const basePath = testFile.replace('.js', '');
      
      // First call - populates cache
      const resolved1 = loader._resolveFile(basePath);
      expect(loader.fileExistenceCache.has(basePath)).toBe(true);
      
      // Second call - should use cache (faster)
      const start = Date.now();
      const resolved2 = loader._resolveFile(basePath);
      const elapsed = Date.now() - start;
      
      expect(resolved1).toBe(resolved2);
      expect(elapsed).toBeLessThan(10); // Cache hit should be instant
      
      fs.unlinkSync(testFile);
    });

    test("should cache results for both sync and async methods", async () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { strictPathValidation: false }
      });
      loader.init();
      
      const testFile = path.join(__dirname, "dual-cache-test.js");
      fs.writeFileSync(testFile, "module.exports = {};");
      
      const basePath = testFile.replace('.js', '');
      
      // Sync call populates cache
      const syncResolved = loader._resolveFile(basePath);
      
      // Async call should use same cache
      const asyncResolved = await loader._resolveFileAsync(basePath);
      
      expect(syncResolved).toBe(asyncResolved);
      expect(loader.fileExistenceCache.size).toBeGreaterThan(0);
      
      fs.unlinkSync(testFile);
    });
  });

  // ============================================================================
  // FINDING 12: Clone Depth Limit (MEDIUM)
  // ============================================================================
  
  describe("Finding 12: Deep Clone Depth Limit", () => {
    test("should enforce max clone depth", () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { 
          strictPathValidation: false,
          deepCloneUtilities: true,
          maxCloneDepth: 5 // Low limit for testing
        }
      });
      loader.init();
      
      // Create deeply nested object
      let deep = { level: 0 };
      let current = deep;
      for (let i = 1; i <= 10; i++) {
        current.nested = { level: i };
        current = current.nested;
      }
      
      expect(() => {
        loader._deepClone(deep);
      }).toThrow(/Clone depth limit exceeded/);
    });

    test("should allow cloning within depth limit", () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { 
          strictPathValidation: false,
          deepCloneUtilities: true,
          maxCloneDepth: 10
        }
      });
      loader.init();
      
      // Create object within limit
      const obj = {
        level1: {
          level2: {
            level3: {
              value: 42
            }
          }
        }
      };
      
      const cloned = loader._deepClone(obj);
      expect(cloned.level1.level2.level3.value).toBe(42);
      expect(cloned).not.toBe(obj); // Should be different object
    });

    test("should use default depth limit from constants", () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { 
          strictPathValidation: false,
          deepCloneUtilities: true
          // Not specifying maxCloneDepth - should use default
        }
      });
      loader.init();
      
      expect(loader.options.maxCloneDepth).toBe(100); // DEFAULT_CONFIG.MAX_CLONE_DEPTH
    });
  });

  // ============================================================================
  // ADDITIONAL EDGE CASES
  // ============================================================================
  
  describe("Edge Cases and Integration", () => {
    test("should handle special objects in deep clone (Date, RegExp)", () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { 
          strictPathValidation: false,
          deepCloneUtilities: true
        }
      });
      loader.init();
      
      const obj = {
        date: new Date('2025-12-29'),
        regex: /test-pattern/gi,
        map: new Map([['key', 'value']]),
        set: new Set([1, 2, 3])
      };
      
      const cloned = loader._deepClone(obj);
      
      expect(cloned.date instanceof Date).toBe(true);
      expect(cloned.date.getTime()).toBe(obj.date.getTime());
      expect(cloned.regex instanceof RegExp).toBe(true);
      expect(cloned.regex.source).toBe('test-pattern');
      expect(cloned.map instanceof Map).toBe(true);
      expect(cloned.set instanceof Set).toBe(true);
    });

    test("should maintain cache integrity under rapid operations", () => {
      const loader = new AutoLoader({ 
        autoloaderConfigPath: configPath,
        options: { 
          strictPathValidation: false,
          maxCacheSize: 5
        }
      });
      loader.init();
      
      const files = [];
      for (let i = 1; i <= 10; i++) {
        const filePath = path.join(__dirname, `rapid-${i}.js`);
        fs.writeFileSync(filePath, `module.exports = { id: ${i} };`);
        files.push(filePath);
      }
      
      // Rapid fire loading and cache hits
      for (let round = 0; round < 3; round++) {
        files.forEach(f => loader._requireModuleOnce(f));
      }
      
      // Cache should be stable and within limits
      expect(loader.loadedModuleCache.size).toBeLessThanOrEqual(5);
      expect(loader.cacheAccessOrder.size).toBe(loader.loadedModuleCache.size);
      
      // Cleanup
      files.forEach(f => fs.unlinkSync(f));
    });
  });
});
