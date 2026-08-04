param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$TargetScript
)

$ErrorActionPreference = "Stop"

$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class VidComJobObjectProbe {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const int JobObjectExtendedLimitInformation = 9;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public uint cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize;
    public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute;
    public uint dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string app, StringBuilder commandLine, IntPtr processAttributes,
    IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd,
    ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass,
    ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok, string operation) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }

  public static uint RunThenClose(string nodePath, string targetScript, string pidFile) {
    var startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(startup);
    var command = new StringBuilder("\"" + nodePath + "\" \"" + targetScript + "\" root \"" + pidFile + "\"");
    PROCESS_INFORMATION process;
    Check(CreateProcess(nodePath, command, IntPtr.Zero, IntPtr.Zero, false,
      CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref startup, out process), "CreateProcess");
    var job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
    try {
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
        (uint)Marshal.SizeOf(limits)), "SetInformationJobObject");
      Check(AssignProcessToJobObject(job, process.hProcess), "AssignProcessToJobObject");
      if (ResumeThread(process.hThread) == UInt32.MaxValue)
        throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
      Thread.Sleep(3000);
      return process.dwProcessId;
    } finally {
      CloseHandle(job);
      CloseHandle(process.hThread);
      CloseHandle(process.hProcess);
    }
  }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$pidFile = Join-Path ([System.IO.Path]::GetTempPath()) ("vidcom-job-object-" + [guid]::NewGuid().ToString("N") + ".json")
try {
  $rootPid = [VidComJobObjectProbe]::RunThenClose(
    [System.IO.Path]::GetFullPath($NodePath),
    [System.IO.Path]::GetFullPath($TargetScript),
    $pidFile
  )
  Start-Sleep -Milliseconds 1000
  $captured = Get-Content -LiteralPath $pidFile -Encoding UTF8 -Raw | ConvertFrom-Json
  $pids = @([int]$captured.rootPid, [int]$captured.childPid, [int]$captured.grandchildPid)
  $survivors = @($pids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  [ordered]@{
    question = "Can a bundled Windows supervisor assign a suspended root before resume and kill its inherited tree by closing a Job Object?"
    createProcessRootPid = $rootPid
    capturedPids = $pids
    survivors = @($survivors | ForEach-Object { $_.Id })
    passed = ($survivors.Count -eq 0 -and $pids.Count -eq 3)
  } | ConvertTo-Json -Depth 4
} finally {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
