// Cloud Configuration System
// Allows the app to connect to a cloud server for data sync

(function() {
  // Get cloud server URL from localStorage
  window.getCloudServer = function() {
    return localStorage.getItem('cloud_server_url') || '';
  };

  // Set cloud server URL
  window.setCloudServer = function(url) {
    if (url) {
      url = url.replace(/\/+$/, ''); // Remove trailing slashes
      localStorage.setItem('cloud_server_url', url);
    } else {
      localStorage.removeItem('cloud_server_url');
    }
  };

  // ============ Render Deploy Hook ============

  // Get Render Deploy Hook URL
  window.getDeployHook = function() {
    return localStorage.getItem('render_deploy_hook') || '';
  };

  // Set Render Deploy Hook URL
  window.setDeployHook = function(url) {
    if (url) {
      url = url.trim().replace(/\s+/g, '');
      localStorage.setItem('render_deploy_hook', url);
    } else {
      localStorage.removeItem('render_deploy_hook');
    }
  };

  // Check if auto-deploy is enabled
  window.isAutoDeployEnabled = function() {
    return localStorage.getItem('auto_deploy_enabled') === 'true';
  };

  // Enable/disable auto-deploy
  window.setAutoDeploy = function(enabled) {
    localStorage.setItem('auto_deploy_enabled', enabled ? 'true' : 'false');
  };

  // Trigger deploy via server proxy (avoids CORS issues)
  // Returns: { success: boolean, message: string }
  window.triggerDeploy = async function() {
    const hookUrl = getDeployHook();
    if (!hookUrl) {
      return { success: false, message: '未配置 Deploy Hook URL' };
    }

    try {
      // Use server-side proxy to avoid CORS
      const res = await fetch('/api/admin/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hookUrl: hookUrl })
      });

      if (res.ok) {
        const data = await res.json();
        return { success: true, message: data.message || '部署已触发', deployId: data.deployId };
      } else {
        const data = await res.json().catch(() => ({}));
        return { success: false, message: data.error || `部署失败 (HTTP ${res.status})` };
      }
    } catch (err) {
      // Fallback: try direct fetch (may fail due to CORS)
      try {
        const res = await fetch(hookUrl, { method: 'POST' });
        if (res.ok) {
          return { success: true, message: '部署已触发（直接调用）' };
        } else {
          return { success: false, message: `部署失败 (HTTP ${res.status})` };
        }
      } catch (e) {
        return { success: false, message: '部署失败：' + (err.message || '网络错误') };
      }
    }
  };

  // Get device ID
  window.getDeviceId = function() {
    let id = localStorage.getItem('device_id');
    if (!id) {
      id = 'dev_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('device_id', id);
    }
    return id;
  };

  // Build full URL for API/image requests
  window.buildUrl = function(path) {
    const cloud = getCloudServer();
    if (cloud && path.startsWith('/')) {
      return cloud + path;
    }
    return path;
  };

  // Intercept fetch to redirect to cloud server
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      // Redirect /api/ and /uploads/ to cloud server (but NOT /api/admin/deploy)
      if ((input.startsWith('/api/') || input.startsWith('/uploads/')) && !input.startsWith('/api/admin/deploy')) {
        input = buildUrl(input);
      }
    }

    // Add device ID header
    if (!init) init = {};
    if (!init.headers) init.headers = {};
    if (init.headers instanceof Headers) {
      init.headers.set('X-Device-Id', getDeviceId());
    } else {
      init.headers['X-Device-Id'] = getDeviceId();
    }

    return originalFetch.call(this, input, init);
  };

  // Intercept image loading
  document.addEventListener('DOMContentLoaded', function() {
    // Override img src to use cloud server
    const observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(function(node) {
            if (node.nodeType === 1) {
              if (node.tagName === 'IMG' && node.src.startsWith(location.origin)) {
                const path = node.getAttribute('src');
                if (path && path.startsWith('/uploads/')) {
                  node.src = buildUrl(path);
                }
              }
              // Check child images
              if (node.querySelectorAll) {
                node.querySelectorAll('img[src^="/uploads/"]').forEach(function(img) {
                  img.src = buildUrl(img.getAttribute('src'));
                });
              }
            }
          });
        }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Fix existing images
    document.querySelectorAll('img[src^="/uploads/"]').forEach(function(img) {
      img.src = buildUrl(img.getAttribute('src'));
    });
  });
})();
