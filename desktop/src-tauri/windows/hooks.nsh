; Claude Code on Windows needs Git for Windows for its Bash tool (ADR-0010). Warn, do not block.
!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $0 HKLM "SOFTWARE\GitForWindows" "InstallPath"
  StrCmp $0 "" 0 git_found
  ReadRegStr $0 HKCU "SOFTWARE\GitForWindows" "InstallPath"
  StrCmp $0 "" 0 git_found
  MessageBox MB_ICONINFORMATION|MB_OK "Loom is installed.$\r$\n$\r$\nClaude Code needs Git for Windows for its Bash tool, and it was not found. Install it from https://git-scm.com/download/win before starting Claude sessions."
  git_found:
!macroend
