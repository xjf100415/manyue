// app.js - 公共工具函数 (首页使用)
// 首页的漫画列表加载逻辑直接写在 index.html 内联脚本中
// 此文件预留给后续扩展使用

function formatTime(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
