# 上传到 GitHub 指南

## 方式一：使用 Git 命令行

在项目根目录执行以下命令：

```bash
# 1. 初始化 Git 仓库
git init

# 2. 添加所有文件
git add .

# 3. 提交文件
git commit -m "Initial commit: SiliconFlow Proxy"

# 4. 添加远程仓库
git remote add origin https://github.com/laolaoshiren/siliconflowProxy.git

# 5. 推送到 GitHub
git branch -M main
git push -u origin main
```

## 方式二：使用 GitHub Desktop

1. 下载并安装 [GitHub Desktop](https://desktop.github.com/)
2. 打开 GitHub Desktop，选择 `File` -> `Add Local Repository`
3. 选择项目目录
4. 在左侧输入提交信息，点击 `Commit to main`
5. 点击 `Publish repository`，选择仓库名称 `siliconflowProxy`

## 方式三：使用 GitHub 网页上传

1. 访问 https://github.com/laolaoshiren/siliconflowProxy
2. 如果仓库不存在，先创建仓库
3. 点击 `uploading an existing file`
4. 拖拽所有项目文件到页面
5. 输入提交信息，点击 `Commit changes`

## 注意事项

- 确保 `.gitignore` 文件已正确配置，避免上传敏感信息
- `data/` 目录包含数据库文件，不应上传
- `node_modules/` 目录不应上传

