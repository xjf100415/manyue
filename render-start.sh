#!/bin/bash
# Render 启动脚本 - 确保持久化磁盘目录存在并初始化
set -e

echo "=== 漫阅 Render 启动 ==="

# 如果持久化磁盘存在，创建必要的子目录
if [ -d "/opt/data" ]; then
  echo "检测到持久化磁盘 /opt/data"
  mkdir -p /opt/data/data
  mkdir -p /opt/data/uploads/covers
  
  # 如果是首次部署，从代码中复制现有数据
  if [ ! -f /opt/data/data/db.json ] && [ -f "$(pwd)/data/db.json" ]; then
    echo "首次部署：复制初始数据库"
    cp "$(pwd)/data/db.json" /opt/data/data/db.json
  fi
  
  echo "持久化存储路径:"
  echo "  数据: /opt/data/data/db.json"
  echo "  上传: /opt/data/uploads/"
else
  echo "未检测到持久化磁盘，使用本地存储"
fi

echo "管理员密码: ${ADMIN_PASSWORD:-bBtz6169}"
echo "=== 启动服务器 ==="

exec node server.js
