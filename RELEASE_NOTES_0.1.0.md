# 邻传 v0.1.0（预发布）

首个公开测试版本。支持任意两台 Mac 或 Windows 电脑在同一局域网互传文件和文件夹。手动输入 IP，通过临时配对码、双端校验码和设备证书建立信任；传输经过 HTTPS 加密，接收方确认后发送。

下载：
- `LanBridge-0.1.0-mac-arm64.zip`：Apple Silicon Mac
- `LanBridge-0.1.0-mac-x64.zip`：Intel Mac
- `LanBridge-0.1.0-win-x64.exe`：Windows x64 便携版

已通过 Mac 界面检查和本机双实例互传测试。2026-10-29，用户反馈 Windows↔Mac、Windows↔Windows 在实机上可用；文件大小与速度尚未记录。软件尚未签名，系统可能出现安全提示。首版不支持断点续传；如网络中断，需要重新发送。
