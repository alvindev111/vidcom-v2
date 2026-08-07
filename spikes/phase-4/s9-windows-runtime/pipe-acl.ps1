# S9/W-2b — read the DACL libuv puts on a named pipe it created with no explicit
# security descriptor. Get-Acl opens the pipe as a file and hits ERROR_PIPE_BUSY,
# so go straight to GetNamedSecurityInfo, which reads the descriptor by name.
param([string]$PipeName)

Add-Type -Namespace W32 -Name Sec -MemberDefinition @'
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern uint GetNamedSecurityInfoW(
    string pObjectName, int ObjectType, int SecurityInfo,
    out IntPtr ppsidOwner, out IntPtr ppsidGroup,
    out IntPtr ppDacl, out IntPtr ppSacl, out IntPtr ppSecurityDescriptor);

[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
    IntPtr sd, uint rev, int si, out IntPtr str, out int len);

[DllImport("kernel32.dll")]
public static extern IntPtr LocalFree(IntPtr h);
'@

$owner = [IntPtr]::Zero; $group = [IntPtr]::Zero; $dacl = [IntPtr]::Zero
$sacl = [IntPtr]::Zero; $sd = [IntPtr]::Zero

# SE_FILE_OBJECT = 1; OWNER|GROUP|DACL = 1|2|4
$rc = [W32.Sec]::GetNamedSecurityInfoW("\\.\pipe\$PipeName", 1, 7,
        [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$sd)
if ($rc -ne 0) { Write-Output "GetNamedSecurityInfo failed rc=$rc"; exit 1 }

$str = [IntPtr]::Zero; $len = 0
if ([W32.Sec]::ConvertSecurityDescriptorToStringSecurityDescriptorW($sd, 1, 7, [ref]$str, [ref]$len)) {
    $sddl = [Runtime.InteropServices.Marshal]::PtrToStringUni($str)
    Write-Output "SDDL: $sddl"
    [W32.Sec]::LocalFree($str) | Out-Null
}

# Translate each ACE identity so the SDDL is readable.
$raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
Write-Output "OWNER: $(try { $raw.Owner.Translate([Security.Principal.NTAccount]).Value } catch { $raw.Owner.Value })"
foreach ($ace in $raw.DiscretionaryAcl) {
    $who = try { $ace.SecurityIdentifier.Translate([Security.Principal.NTAccount]).Value } catch { $ace.SecurityIdentifier.Value }
    Write-Output ("ACE: {0} type={1} mask=0x{2:X}" -f $who, $ace.AceType, $ace.AccessMask)
}
[W32.Sec]::LocalFree($sd) | Out-Null
