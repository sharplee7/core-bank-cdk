# 1. 기존 파일 삭제
Remove-Item .\git-permission-guard.ps1

# 2. 위 새 코드를 git-permission-guard.ps1로 저장

# 3. 실행
powershell -ExecutionPolicy Bypass -File .\git-permission-guard.ps1
