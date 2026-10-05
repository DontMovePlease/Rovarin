using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RovarinUninstallArguments {
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command,out int argc);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static string[] Parse(string command) {
        bool quoted=false,escape=false;
        foreach(char c in command){if(c=='"'&&!escape)quoted=!quoted;escape=c=='\\'&&!escape;}
        if(quoted)throw new ArgumentException();
        int count;var memory=CommandLineToArgvW(command,out count);if(memory==IntPtr.Zero)throw new ArgumentException();
        try{if(count<1||count>32)throw new ArgumentException();var args=new List<string>();for(int i=0;i<count;i++)args.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size)));return args.ToArray();}finally{LocalFree(memory);}
    }
    public static string Quote(string value) {
        var output=new System.Text.StringBuilder("\"");int slashes=0;
        foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"'){output.Append('\\',slashes*2+1);output.Append(c);}else{output.Append('\\',slashes);output.Append(c);}slashes=0;}
        output.Append('\\',slashes*2);output.Append('"');return output.ToString();
    }
}
