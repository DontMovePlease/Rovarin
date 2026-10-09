using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public static class RovarinLeftovers {
    const uint Read=0x80000000, Attr=0x80, Delete=0x10000, Backup=0x02000000, OpenReparse=0x00200000;
    const int MaxEntries=4096, MaxDepth=12;
    const long MaxBytes=536870912;
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int type,ref Disposition info,uint size);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFileAttributes(string path);
    [StructLayout(LayoutKind.Sequential)] struct Info {public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
    [StructLayout(LayoutKind.Sequential)] struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
    public sealed class Candidate { public string Path,Source,Identity; }
    public sealed class Entry { public string Relative,Identity,Hash;public bool Directory;public long Bytes; }
    public sealed class Manifest {public Candidate Candidate;public Entry[] Entries;public long Bytes;public int Files;public string Fingerprint;}
    public sealed class Scan {public bool success=true;public string code="scanned";public List<Manifest> manifests=new List<Manifest>();public List<object> excluded=new List<object>();}
    public sealed class Removal {public bool success;public string code;public long bytesRemoved;public int filesRemoved,filesSkipped,filesFailed;public bool folderRemoved;public List<object> details=new List<object>();}
    static string Full(string p) {
        if(string.IsNullOrWhiteSpace(p)||p.Length>240||p.Length<3||p[1]!=':'||p[2]!='\\'||p.Substring(2).Contains(':')||p.Contains("\0"))throw new IOException("unsafe-path");
        return System.IO.Path.GetFullPath(p).TrimEnd('\\');
    }
    static bool Under(string p,string root){return p.Equals(root,StringComparison.OrdinalIgnoreCase)||p.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase);}
    public static bool Allowed(string path) {
        try {
            string p=Full(path);if(p.Length<=3)return false;
            foreach(string variable in new[]{"SystemRoot","USERPROFILE","LOCALAPPDATA","APPDATA","ProgramData","ProgramFiles","ProgramFiles(x86)","ProgramW6432","TEMP","TMP"}) {
                string value=Environment.GetEnvironmentVariable(variable);if(string.IsNullOrEmpty(value))continue;string root=Full(value);
                if(p.Equals(root,StringComparison.OrdinalIgnoreCase)||(variable=="SystemRoot"&&Under(p,root)))return false;
            }
            foreach(Environment.SpecialFolder special in new[]{Environment.SpecialFolder.DesktopDirectory,Environment.SpecialFolder.MyDocuments,Environment.SpecialFolder.MyPictures,Environment.SpecialFolder.MyMusic,Environment.SpecialFolder.MyVideos}) {
                string root=Environment.GetFolderPath(special);if(root!=""&&Under(p,Full(root)))return false;
            }
            string profile=Environment.GetEnvironmentVariable("USERPROFILE");
            if(!string.IsNullOrEmpty(profile)&&Under(p,Full(System.IO.Path.Combine(profile,"Downloads"))))return false;
            foreach(string part in p.Split('\\').Skip(1)) {
                if(new[]{"WindowsApps","Common Files","Rovarin","RovarinDevelopment","PC Monitor","Microsoft","Programs","Packages","steamapps","common","Users","AppData"}.Contains(part,StringComparer.OrdinalIgnoreCase) && p.EndsWith("\\"+part,StringComparison.OrdinalIgnoreCase))return false;
            }
            return true;
        } catch{return false;}
    }
    static SafeFileHandle Open(string p,bool directory,bool deleting) {
        uint access=directory?Attr:Read|Attr;if(deleting)access|=Delete;
        uint share=deleting&&!directory?0u:directory?3u:7u;
        var h=CreateFile(p,access,share,IntPtr.Zero,3,Backup|OpenReparse,IntPtr.Zero);
        if(h.IsInvalid){h.Dispose();throw new IOException("locked-or-inaccessible");}
        Info i;if(!GetFileInformationByHandle(h,out i)||(i.Attributes&0x400)!=0||((i.Attributes&0x10)!=0)!=directory||(!directory&&i.Links!=1)){h.Dispose();throw new IOException("redirected-or-shared-file");}
        return h;
    }
    static string Identity(SafeFileHandle h) {
        Info i;if(!GetFileInformationByHandle(h,out i))throw new IOException("identity-unavailable");
        return string.Join(":",new uint[]{i.Volume,i.IndexHigh,i.IndexLow,i.CreationHigh,i.CreationLow,i.WriteHigh,i.WriteLow,i.SizeHigh,i.SizeLow,i.Attributes,i.Links}.Select(x=>x.ToString("x8")));
    }
    static string DirectoryId(SafeFileHandle h) {Info i;if(!GetFileInformationByHandle(h,out i))throw new IOException("identity-unavailable");return string.Join(":",new uint[]{i.Volume,i.IndexHigh,i.IndexLow,i.CreationHigh,i.CreationLow}.Select(x=>x.ToString("x8")));}
    static long Length(SafeFileHandle h){Info i;if(!GetFileInformationByHandle(h,out i))throw new IOException("identity-unavailable");return ((long)i.SizeHigh<<32)|i.SizeLow;}
    static List<SafeFileHandle> Ancestors(string p) {
        var handles=new List<SafeFileHandle>();try {
            string parent=System.IO.Path.GetDirectoryName(p);var chain=new List<string>();
            while(!string.IsNullOrEmpty(parent)){chain.Add(parent);var next=System.IO.Path.GetDirectoryName(parent);if(next==parent)break;parent=next;}
            chain.Reverse();foreach(string item in chain){var h=CreateFile(item,Attr,3,IntPtr.Zero,3,Backup|OpenReparse,IntPtr.Zero);Info i;if(h.IsInvalid||!GetFileInformationByHandle(h,out i)||(i.Attributes&0x410)!=0x10){h.Dispose();throw new IOException("redirected-parent");}handles.Add(h);}return handles;
        } catch {foreach(var h in handles)h.Dispose();throw;}
    }
    static string Digest(string text){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-","").ToLowerInvariant();}
    static string Hash(SafeFileHandle h,Stopwatch watch) {
        using(var stream=new FileStream(new SafeFileHandle(h.DangerousGetHandle(),false),FileAccess.Read,65536,false))using(var sha=SHA256.Create()) {
            var buffer=new byte[65536];int count;stream.Position=0;
            while((count=stream.Read(buffer,0,buffer.Length))>0){if(watch.ElapsedMilliseconds>15000)throw new IOException("scan-limit");sha.TransformBlock(buffer,0,count,buffer,0);}sha.TransformFinalBlock(new byte[0],0,0);return BitConverter.ToString(sha.Hash).Replace("-","").ToLowerInvariant();
        }
    }
    public static Candidate Capture(string path,string source) {
        if(!Allowed(path))throw new IOException("protected-location");string p=Full(path);var parents=Ancestors(p);
        try {using(var h=Open(p,true,false))return new Candidate{Path=p,Source=source,Identity=DirectoryId(h)};}finally{foreach(var h in parents)h.Dispose();}
    }
    static Manifest Snapshot(Candidate c,Stopwatch watch,Dictionary<string,SafeFileHandle> locked=null) {
        string root=Full(c.Path);if(!Allowed(root))throw new IOException("protected-location");var parents=Ancestors(root);var stable=new List<SafeFileHandle>();
        try {
            var rh=Open(root,true,false);stable.Add(rh);if(DirectoryId(rh)!=c.Identity)throw new IOException("folder-changed");
            var entries=new List<Entry>();long bytes=0;var pending=new Stack<Tuple<string,int>>();pending.Push(Tuple.Create(root,0));
            while(pending.Count>0) {
                var current=pending.Pop();if(current.Item2>MaxDepth||entries.Count>=MaxEntries||watch.ElapsedMilliseconds>15000)throw new IOException("scan-limit");
                foreach(string full in Directory.EnumerateFileSystemEntries(current.Item1)) {
                    if(entries.Count>=MaxEntries||watch.ElapsedMilliseconds>15000)throw new IOException("scan-limit");
                    string p=Full(full);if(!Under(p,root)||p==root)throw new IOException("unsafe-path");uint attributes=GetFileAttributes(p);if(attributes==uint.MaxValue||(attributes&0x400)!=0)throw new IOException("redirected-or-inaccessible");bool directory=(attributes&0x10)!=0;
                    SafeFileHandle h=null;bool owns=locked==null;
                    try {
                        if(owns){h=Open(p,directory,false);if(directory)stable.Add(h);}else if(!locked.TryGetValue(p,out h))throw new IOException("preview-changed");
                        string identity=Identity(h);long length=directory?0:Length(h);bytes+=length;if(bytes>MaxBytes)throw new IOException("scan-limit");
                        string hash=directory?"":Hash(h,watch);if(identity!=Identity(h))throw new IOException("preview-changed");
                        entries.Add(new Entry{Relative=p.Substring(root.Length+1),Directory=directory,Identity=identity,Hash=hash,Bytes=length});if(directory)pending.Push(Tuple.Create(p,current.Item2+1));
                    }finally{if(owns&&h!=null&&!directory)h.Dispose();}
                }
            }
            entries.Sort((a,b)=>StringComparer.OrdinalIgnoreCase.Compare(a.Relative,b.Relative));
            string fp=Digest(c.Identity+"|"+string.Join("\n",entries.Select(e=>e.Relative+"|"+e.Directory+"|"+e.Identity+"|"+e.Hash)));
            return new Manifest{Candidate=c,Entries=entries.ToArray(),Bytes=bytes,Files=entries.Count(e=>!e.Directory),Fingerprint=fp};
        }finally{foreach(var h in stable)h.Dispose();foreach(var h in parents)h.Dispose();}
    }
    public static Scan Inspect(Candidate[] candidates) {
        var result=new Scan();var watch=Stopwatch.StartNew();if(candidates==null||candidates.Length>24)throw new IOException("candidate-limit");
        foreach(var c in candidates){try{result.manifests.Add(Snapshot(c,watch));}catch(Exception e){result.excluded.Add(new{location=c.Path,reason=e is IOException?e.Message:"inaccessible"});}}
        return result;
    }
    static bool Gone(string path){uint attributes=GetFileAttributes(path);int error=Marshal.GetLastWin32Error();return attributes==uint.MaxValue&&(error==2||error==3);}
    static void RegistrationGuard(string scope,string key,string root) {
        if(scope!="appx"&&scope!="user"&&scope!="machine64"&&scope!="machine32")throw new IOException("unverified-application");
        if(string.IsNullOrEmpty(key)||key.Length>300||key.IndexOfAny(new[]{'\\','/','\r','\n'})>=0)throw new IOException("unverified-application");
        string baseKey="Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
        foreach(var hive in new[]{Microsoft.Win32.RegistryHive.CurrentUser,Microsoft.Win32.RegistryHive.LocalMachine})foreach(var view in new[]{Microsoft.Win32.RegistryView.Registry64,Microsoft.Win32.RegistryView.Registry32}) {
            using(var registry=Microsoft.Win32.RegistryKey.OpenBaseKey(hive,view))using(var uninstall=registry.OpenSubKey(baseKey)) {
                if(uninstall==null)continue;
                foreach(string name in uninstall.GetSubKeyNames())using(var entry=uninstall.OpenSubKey(name)) {
                    if(entry==null)continue;
                    bool current=(scope=="user"&&hive==Microsoft.Win32.RegistryHive.CurrentUser&&view==Microsoft.Win32.RegistryView.Registry64)||(scope=="machine64"&&hive==Microsoft.Win32.RegistryHive.LocalMachine&&view==Microsoft.Win32.RegistryView.Registry64)||(scope=="machine32"&&hive==Microsoft.Win32.RegistryHive.LocalMachine&&view==Microsoft.Win32.RegistryView.Registry32);
                    if(current&&name.Equals(key,StringComparison.OrdinalIgnoreCase))throw new IOException("application-present");
                    string location=entry.GetValue("InstallLocation") as string;if(string.IsNullOrEmpty(location))continue;
                    try{location=Full(location);}catch{continue;}
                    if(Under(root,location)||Under(location,root))throw new IOException("shared-application-folder");
                }
            }
        }
    }
    public static Removal Remove(Manifest approved,string scope,string key) {
        var result=new Removal();var locked=new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);List<SafeFileHandle> parents=null;SafeFileHandle root=null;bool begun=false;
        try {
            if(approved==null||approved.Candidate==null||approved.Entries==null||approved.Entries.Length>MaxEntries)throw new IOException("invalid-preview");
            string p=Full(approved.Candidate.Path);if(!Allowed(p))throw new IOException("protected-location");parents=Ancestors(p);root=Open(p,true,true);RegistrationGuard(scope,key,p);
            if(DirectoryId(root)!=approved.Candidate.Identity)throw new IOException("folder-changed");
            // Lock every approved object before checking the complete preview. Never recursively delete by path.
            foreach(var entry in approved.Entries.OrderBy(e=>e.Relative.Count(ch=>ch=='\\'))) {
                string item=Full(System.IO.Path.Combine(p,entry.Relative));if(!Under(item,p)||item==p||locked.ContainsKey(item))throw new IOException("unsafe-preview");locked.Add(item,Open(item,entry.Directory,true));
            }
            var current=Snapshot(approved.Candidate,Stopwatch.StartNew(),locked);if(current.Fingerprint!=approved.Fingerprint)throw new IOException("preview-changed");
            RegistrationGuard(scope,key,p);begun=true;
            foreach(var entry in approved.Entries.OrderBy(e=>e.Directory?1:0).ThenByDescending(e=>e.Relative.Count(ch=>ch=='\\'))) {
                string item=Full(System.IO.Path.Combine(p,entry.Relative));var h=locked[item];var disposition=new Disposition{DeleteFile=true};
                if(!SetFileInformationByHandle(h,4,ref disposition,4)){if(!entry.Directory)result.filesFailed++;result.details.Add(new{location=entry.Relative,reason="locked-readonly-or-access-denied"});h.Dispose();locked.Remove(item);continue;}
                h.Dispose();locked.Remove(item);
                if(!Gone(item)){if(!entry.Directory)result.filesFailed++;result.details.Add(new{location=entry.Relative,reason="removal-not-confirmed"});continue;}
                if(!entry.Directory){result.filesRemoved++;result.bytesRemoved+=entry.Bytes;}
            }
            var end=new Disposition{DeleteFile=true};bool removed=SetFileInformationByHandle(root,4,ref end,4);root.Dispose();root=null;
            result.folderRemoved=removed&&Gone(p);if(!result.folderRemoved)result.details.Add(new{location="Folder",reason="new-or-remaining-files"});
            result.success=result.folderRemoved&&result.filesFailed==0;result.code=result.success?"completed":"partial";
        }catch(Exception e){result.filesSkipped=approved==null?0:Math.Max(0,approved.Files-result.filesRemoved-result.filesFailed);result.success=false;result.code=begun?"partial":"skipped";result.details.Add(new{location="Folder",reason=e is IOException?e.Message:"inaccessible"});}
        finally{foreach(var h in locked.Values)h.Dispose();if(root!=null)root.Dispose();if(parents!=null)foreach(var h in parents)h.Dispose();}
        return result;
    }
}
