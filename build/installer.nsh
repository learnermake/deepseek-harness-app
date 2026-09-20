; NSIS 自定义片段：卸载时询问是否一并删除缓存数据。
;
; 默认策略：卸载【保留】%APPDATA%\DeepSeekHarness（内含已下载/已释放的 harness 版本树，
; 动辄数百 MB，重装后可继续复用）。只有当用户明确勾选时才删除。
;
; $APPDATA 在 electron-builder 的 NSIS 里已被定义为每个用户的 Roaming 目录。

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否同时删除 DeepSeek Harness 的缓存数据？$\r$\n$\r$\n包含已下载的 harness 版本（数百 MB）与本地设置、日志。$\r$\n选择“否”则保留，重装后可直接复用。" \
    /SD IDNO IDNO skip_cleanup

    RMDir /r "$APPDATA\DeepSeekHarness"
    DetailPrint "已删除缓存数据: $APPDATA\DeepSeekHarness"

  skip_cleanup:
!macroend
