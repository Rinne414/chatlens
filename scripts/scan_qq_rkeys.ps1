[CmdletBinding()]
param()

# Prints "count<TAB>rkey" for every rkey= token found in the running QQ
# processes' memory, most frequent first. READ-ONLY: the same OpenProcess +
# ReadProcessMemory access as scan_qq_memory_keys.ps1. Nothing is written to
# disk; the caller (src/rkey.js) validates the candidates against a real
# picture and keeps the working one in memory only.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$ids = @(Get-Process -Name 'QQ' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if ($ids.Count -eq 0) {
    [Console]::Error.WriteLine('no-qq')
    exit 3
}

$code = @'
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

public static class QqRkeyScanner
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MBI
    {
        public ulong BaseAddress; public ulong AllocationBase; public uint AllocationProtect; public uint A1;
        public ulong RegionSize; public uint State; public uint Protect; public uint Type; public uint A2;
    }

    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern UIntPtr VirtualQueryEx(IntPtr handle, UIntPtr address, out MBI info, UIntPtr length);
    [DllImport("kernel32.dll")] private static extern bool ReadProcessMemory(IntPtr handle, UIntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);

    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_VM_READ = 0x0010;
    private const uint MEM_COMMIT = 0x1000;
    private const uint PAGE_NOACCESS = 0x01;
    private const uint PAGE_GUARD = 0x100;
    private const int CHUNK = 4 * 1024 * 1024;
    private const int OVERLAP = 256;
    private const int MIN_KEY = 40;
    private const int MAX_KEY = 200;
    private static readonly byte[] Needle = Encoding.ASCII.GetBytes("rkey=");

    private static bool IsKeyChar(byte c)
    {
        return (c >= (byte)'A' && c <= (byte)'Z') || (c >= (byte)'a' && c <= (byte)'z')
            || (c >= (byte)'0' && c <= (byte)'9') || c == (byte)'_' || c == (byte)'-';
    }

    public static string[] Scan(int[] pids)
    {
        var found = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (int pid in pids)
        {
            IntPtr handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
            if (handle == IntPtr.Zero) { continue; }
            try { ScanProcess(handle, found); }
            finally { CloseHandle(handle); }
        }
        return found.OrderByDescending(pair => pair.Value).Select(pair => pair.Value + "\t" + pair.Key).ToArray();
    }

    private static void ScanProcess(IntPtr handle, Dictionary<string, int> found)
    {
        ulong address = 0;
        int infoSize = Marshal.SizeOf(typeof(MBI));
        while (address < 0x00007FFFFFFEFFFFUL)
        {
            MBI info;
            if (VirtualQueryEx(handle, new UIntPtr(address), out info, new UIntPtr((uint)infoSize)) == UIntPtr.Zero)
            {
                address += 0x10000;
                continue;
            }
            ulong next = info.BaseAddress + info.RegionSize;
            bool readable = info.State == MEM_COMMIT && (info.Protect & PAGE_GUARD) == 0 && (info.Protect & PAGE_NOACCESS) == 0;
            if (readable && info.RegionSize < (1UL << 32))
            {
                ScanRegion(handle, info.BaseAddress, info.RegionSize, found);
            }
            if (next <= address) { break; }
            address = next;
        }
    }

    private static void ScanRegion(IntPtr handle, ulong baseAddress, ulong size, Dictionary<string, int> found)
    {
        for (ulong offset = 0; offset < size; offset += (ulong)CHUNK)
        {
            int length = (int)Math.Min((ulong)(CHUNK + OVERLAP), size - offset);
            byte[] buffer = new byte[length];
            UIntPtr read;
            if (!ReadProcessMemory(handle, new UIntPtr(baseAddress + offset), buffer, new UIntPtr((uint)length), out read)) { continue; }
            int count = (int)read.ToUInt64();
            for (int i = 0; i + Needle.Length < count; i++)
            {
                if (!Matches(buffer, i)) { continue; }
                int start = i + Needle.Length;
                int end = start;
                while (end < count && IsKeyChar(buffer[end])) { end++; }
                int keyLength = end - start;
                if (keyLength >= MIN_KEY && keyLength <= MAX_KEY)
                {
                    string key = Encoding.ASCII.GetString(buffer, start, keyLength);
                    int seen;
                    found.TryGetValue(key, out seen);
                    found[key] = seen + 1;
                }
                i = end;
            }
        }
    }

    private static bool Matches(byte[] buffer, int at)
    {
        for (int k = 0; k < Needle.Length; k++)
        {
            if (buffer[at + k] != Needle[k]) { return false; }
        }
        return true;
    }
}
'@

Add-Type -TypeDefinition $code -Language CSharp
foreach ($line in [QqRkeyScanner]::Scan([int[]]$ids)) {
    [Console]::Out.WriteLine($line)
}
