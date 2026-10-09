using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class RovarinProcessTree {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Entry {
        public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
    }
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h,ref Entry e);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr h,ref Entry e);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h,out long c,out long e,out long k,out long u);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder image,ref uint size);
    [DllImport("kernel32.dll")] static extern bool IsProcessCritical(IntPtr h,out bool critical);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    public class Outcome { public int pid; public string name, code, startedAt; }
    public class Result { public bool success, verified; public string code; public int descendantCount; public List<Outcome> members=new List<Outcome>(); public List<Outcome> results=new List<Outcome>(); public List<int> remaining=new List<int>(); }
    class Node { public int pid, depth; public string name; public long creation; public IntPtr handle; public bool processed; }
    static bool ProtectedName(string name) {
        string[] names={"idle","system","smss","csrss","wininit","winlogon","lsass","services","rovarin","pcmonitor"};
        foreach(string n in names) if(String.Equals(n,name,StringComparison.OrdinalIgnoreCase))return true; return false;
    }
    static List<Entry> Snapshot() {
        IntPtr h=CreateToolhelp32Snapshot(2,0); if(h==new IntPtr(-1))throw new InvalidOperationException();
        var rows=new List<Entry>(); try {var e=new Entry();e.size=(uint)Marshal.SizeOf(typeof(Entry));if(!Process32FirstW(h,ref e))throw new InvalidOperationException();do {rows.Add(e);}while(Process32NextW(h,ref e));}finally{CloseHandle(h);}return rows;
    }
    static Node Open(int pid,int depth,out string failure) {
        failure="access-denied"; IntPtr h=OpenProcess(0x100000|0x1000|1,false,pid);
        if(h==IntPtr.Zero){if(Marshal.GetLastWin32Error()==87)failure="already-exited";return null;}
        long c,e,k,u;var image=new StringBuilder(32768);uint size=32768;bool critical;
        if(WaitForSingleObject(h,0)==0){failure="already-exited";CloseHandle(h);return null;}
        if(!GetProcessTimes(h,out c,out e,out k,out u)||!QueryFullProcessImageName(h,0,image,ref size)||!IsProcessCritical(h,out critical)){CloseHandle(h);return null;}
        string name=Path.GetFileNameWithoutExtension(image.ToString());
        if(critical||ProtectedName(name)){failure="protected-process";CloseHandle(h);return null;}
        return new Node{pid=pid,depth=depth,name=name,creation=c,handle=h};
    }
    // Each handle pins one process object. Parent edges are accepted only within
    // the parent's actual lifetime; a recycled parent PID cannot absorb an unrelated child.
    static void Collect(List<Entry> rows,Dictionary<int,Node> nodes,HashSet<int> protectedIds,Result result) {
        bool added=true; while(added){added=false;foreach(var row in rows){
            int pid=(int)row.pid;Node parent;if(nodes.ContainsKey(pid)||!nodes.TryGetValue((int)row.parent,out parent)||pid==parent.pid)continue;
            if(nodes.Count>=512)throw new InvalidOperationException("bounded-tree");
            string failure;Node child=Open(pid,parent.depth+1,out failure);
            if(child==null){result.results.Add(new Outcome{pid=pid,name=Path.GetFileNameWithoutExtension(row.exe),code=failure});if(failure!="already-exited")result.remaining.Add(pid);if(failure=="protected-process"||protectedIds.Contains(pid))throw new InvalidOperationException("protected-process");continue;}
            long c,e,k,u;if(!GetProcessTimes(parent.handle,out c,out e,out k,out u)||child.creation<parent.creation||(e!=0&&child.creation>e)){CloseHandle(child.handle);continue;}
            if(protectedIds.Contains(pid)){CloseHandle(child.handle);throw new InvalidOperationException("protected-process");}
            nodes.Add(pid,child);added=true;
        }}
    }
    // First supplied PID is the backend: protect its descendants. Additional
    // PIDs (launcher/watcher) protect that exact object, not its unrelated children.
    public static bool IsOwnedTarget(int pid,int[] protectedPids) {
        var protectedIds=new HashSet<int>(protectedPids??new int[0]);var rows=Snapshot();var seen=new HashSet<int>();int current=pid;
        while(current>0&&seen.Add(current)){if(protectedIds.Contains(current)&&(current==pid||(protectedPids.Length>0&&current==protectedPids[0])))return true;bool found=false;foreach(var row in rows)if(row.pid==(uint)current){if(String.Equals(Path.GetFileNameWithoutExtension(row.exe),"Rovarin",StringComparison.OrdinalIgnoreCase)||String.Equals(Path.GetFileNameWithoutExtension(row.exe),"PCMonitor",StringComparison.OrdinalIgnoreCase))return true;current=(int)row.parent;found=true;break;}if(!found)break;}
        return false;
    }
    public static Result Run(int pid,string name,long time,int[] protectedPids,bool execute) {
        var result=new Result{code="tree-unavailable"};var nodes=new Dictionary<int,Node>();var protectedIds=new HashSet<int>(protectedPids??new int[0]);protectedIds.Add(Process.GetCurrentProcess().Id);
        try {
            if(protectedIds.Contains(pid)){result.code="protected-process";return result;}
            string failure;var root=Open(pid,0,out failure);if(root==null){result.code=failure;return result;}nodes.Add(pid,root);
            if(root.creation!=time||!String.Equals(root.name,name,StringComparison.OrdinalIgnoreCase)){result.code="stale-process";return result;}
            if(IsOwnedTarget(pid,protectedPids)){result.code="protected-process";return result;}
            Collect(Snapshot(),nodes,protectedIds,result);result.descendantCount=nodes.Count-1;
            if(!execute){foreach(var member in nodes.Values)result.members.Add(new Outcome{pid=member.pid,name=member.name,startedAt=DateTime.FromFileTimeUtc(member.creation).ToString("o"),code="verified"});result.code="tree-preview";result.success=true;return result;}
            var clock=Stopwatch.StartNew();
            for(int pass=0;pass<4&&clock.ElapsedMilliseconds<8000;pass++){
                if(pass>0)Collect(Snapshot(),nodes,protectedIds,result);
                var targets=new List<Node>(nodes.Values);targets.Sort((a,b)=>b.depth.CompareTo(a.depth));
                foreach(var target in targets){if(clock.ElapsedMilliseconds>=8000)break;if(target.processed)continue;target.processed=true;string code;
                    if(WaitForSingleObject(target.handle,0)==0)code="already-exited";
                    else if(!TerminateProcess(target.handle,1))code=WaitForSingleObject(target.handle,0)==0?"already-exited":"access-denied";
                    else code=WaitForSingleObject(target.handle,500)==0?"terminated":"termination-unconfirmed";
                    result.results.Add(new Outcome{pid=target.pid,name=target.name,startedAt=DateTime.FromFileTimeUtc(target.creation).ToString("o"),code=code});
                }
            }
            Collect(Snapshot(),nodes,protectedIds,result);
            foreach(var target in nodes.Values)if(WaitForSingleObject(target.handle,0)!=0&&!result.remaining.Contains(target.pid))result.remaining.Add(target.pid);
            result.descendantCount=nodes.Count-1;result.success=result.remaining.Count==0;result.verified=result.success;result.code=result.success?"tree-terminated":"tree-partial";
        }catch(InvalidOperationException error){result.code=error.Message=="protected-process"?"protected-process":"tree-unavailable";result.success=false;}catch{result.code="tree-unavailable";result.success=false;}
        finally{foreach(var target in nodes.Values)CloseHandle(target.handle);}return result;
    }
}
