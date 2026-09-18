# WPS Windows 操作指南

## 原则

首选 Windows UI Automation 和稳定快捷键，不把绝对坐标作为长期 Runbook 依据。

## 常用快捷键

- Ctrl+O：打开文件
- Ctrl+S：保存
- Ctrl+Shift+S：另存为
- Ctrl+F：查找
- Ctrl+P：打印
- Ctrl+W：关闭当前文档

## 建议操作顺序

1. 激活 WPS 窗口。
2. 能用快捷键完成的操作优先用 `desktop_hotkey`。
3. 对话框和按钮优先通过 `desktop_snapshot` + `desktop_click_target`。
4. 自绘区域无法暴露 UIA 时才使用 OCR。
5. 坐标点击只用于本轮 CURRENT 视觉证据明确的目标。
