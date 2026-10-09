using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class RovarinAppMetadata {
    private static readonly HashSet<string> DisallowedRoots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    static RovarinAppMetadata() {
        string[] envVars = new string[] {
            "SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
            "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramData", "TEMP", "TMP"
        };
        foreach (string v in envVars) {
            try {
                string val = Environment.GetEnvironmentVariable(v);
                if (!string.IsNullOrEmpty(val)) {
                    DisallowedRoots.Add(Path.GetFullPath(val).TrimEnd('\\'));
                }
            } catch { }
        }
        try {
            string sysDrive = Environment.GetEnvironmentVariable("SystemDrive") ?? "C:";
            DisallowedRoots.Add(Path.GetFullPath(sysDrive + "\\").TrimEnd('\\'));
            DisallowedRoots.Add(Path.GetFullPath(sysDrive + "\\Windows").TrimEnd('\\'));
            DisallowedRoots.Add(Path.GetFullPath(sysDrive + "\\Users").TrimEnd('\\'));
            DisallowedRoots.Add(Path.GetFullPath(sysDrive + "\\Program Files").TrimEnd('\\'));
            DisallowedRoots.Add(Path.GetFullPath(sysDrive + "\\Program Files (x86)").TrimEnd('\\'));
            DisallowedRoots.Add(Path.GetFullPath(sysDrive + "\\ProgramData").TrimEnd('\\'));
            string progFiles = Environment.GetEnvironmentVariable("ProgramFiles");
            if (!string.IsNullOrEmpty(progFiles)) {
                DisallowedRoots.Add(Path.GetFullPath(Path.Combine(progFiles, "WindowsApps")).TrimEnd('\\'));
            }
            string progW6432 = Environment.GetEnvironmentVariable("ProgramW6432");
            if (!string.IsNullOrEmpty(progW6432)) {
                DisallowedRoots.Add(Path.GetFullPath(Path.Combine(progW6432, "WindowsApps")).TrimEnd('\\'));
            }
            string localApp = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (!string.IsNullOrEmpty(localApp)) {
                DisallowedRoots.Add(Path.GetFullPath(Path.Combine(localApp, "Programs")).TrimEnd('\\'));
            }
        } catch { }
    }

    public static bool IsSafeDirectory(string rawDir) {
        if (string.IsNullOrWhiteSpace(rawDir)) return false;
        try {
            if (!Path.IsPathRooted(rawDir)) return false;
            string full = Path.GetFullPath(rawDir).TrimEnd('\\');
            string root = Path.GetPathRoot(full).TrimEnd('\\');
            if (full.Equals(root, StringComparison.OrdinalIgnoreCase)) return false;
            if (DisallowedRoots.Contains(full)) return false;
            if (full.EndsWith("\\steamapps\\common", StringComparison.OrdinalIgnoreCase) ||
                full.EndsWith("\\steamapps", StringComparison.OrdinalIgnoreCase)) return false;
            if (!Directory.Exists(full)) return false;
            DirectoryInfo di = new DirectoryInfo(full);
            if ((di.Attributes & FileAttributes.ReparsePoint) != 0) return false;
            return true;
        } catch {
            return false;
        }
    }

    public static long CalculateDirectorySize(string rawDir, int maxFiles) {
        if (!IsSafeDirectory(rawDir)) return -1;
        try {
            DirectoryInfo root = new DirectoryInfo(rawDir);
            string normalizedRoot = root.FullName.TrimEnd('\\') + '\\';
            var deadline = System.Diagnostics.Stopwatch.StartNew();
            long totalBytes = 0;
            int fileCount = 0;
            Queue<DirectoryInfo> queue = new Queue<DirectoryInfo>();
            queue.Enqueue(root);

            while (queue.Count > 0) {
                if (deadline.ElapsedMilliseconds > 100) return -1;
                DirectoryInfo current = queue.Dequeue();
                FileInfo[] files;
                try { files = current.GetFiles(); }
                catch { continue; }

                foreach (FileInfo f in files) {
                    try {
                        if ((f.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                        totalBytes += f.Length;
                        fileCount++;
                        if (fileCount > maxFiles) return -1;
                    } catch { }
                }

                DirectoryInfo[] subDirs;
                try { subDirs = current.GetDirectories(); }
                catch { continue; }

                foreach (DirectoryInfo sub in subDirs) {
                    try {
                        if ((sub.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                        if (!sub.FullName.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase)) continue;
                        queue.Enqueue(sub);
                    } catch { }
                }
            }
            return totalBytes;
        } catch {
            return -1;
        }
    }

    public static string ResolveAppXLogo(string installLocation, string relativeLogoPath) {
        if (string.IsNullOrWhiteSpace(installLocation) || string.IsNullOrWhiteSpace(relativeLogoPath)) return null;
        try {
            if (!IsSafeDirectory(installLocation)) return null;
            string full = Path.GetFullPath(Path.Combine(installLocation, relativeLogoPath));
            string normInstall = Path.GetFullPath(installLocation).TrimEnd('\\') + '\\';
            if (!full.StartsWith(normInstall, StringComparison.OrdinalIgnoreCase)) return null;
            if (File.Exists(full)) return full;

            string dir = Path.GetDirectoryName(full);
            if (!Directory.Exists(dir)) return null;
            string stem = Path.GetFileNameWithoutExtension(full);
            string[] candidates = Directory.GetFiles(dir, stem + ".*.png");
            if (candidates.Length == 0) candidates = Directory.GetFiles(dir, stem + "*.png");
            if (candidates.Length > 0) {
                string[] preferred = new string[] {
                    "targetsize-48", "targetsize-44", "targetsize-32", "targetsize-24",
                    "scale-100", "scale-125", "scale-150", "scale-200"
                };
                foreach (string pref in preferred) {
                    foreach (string c in candidates) {
                        if (c.IndexOf(pref, StringComparison.OrdinalIgnoreCase) >= 0) return c;
                    }
                }
                return candidates[0];
            }
        } catch { }
        return null;
    }

    public static string ResolveInstallLocationIcon(string installLocation, string appName) {
        if (string.IsNullOrWhiteSpace(installLocation)) return null;
        try {
            if (!IsSafeDirectory(installLocation)) return null;
            string full = Path.GetFullPath(installLocation);

            // 1. Look for .ico files in root of install directory
            string[] icos = Directory.GetFiles(full, "*.ico");
            if (icos.Length > 0) {
                foreach (string ico in icos) {
                    string name = Path.GetFileNameWithoutExtension(ico);
                    if (name.Equals("app", StringComparison.OrdinalIgnoreCase) ||
                        name.Equals("icon", StringComparison.OrdinalIgnoreCase) ||
                        (!string.IsNullOrEmpty(appName) && name.IndexOf(appName, StringComparison.OrdinalIgnoreCase) >= 0)) {
                        string b64 = ExtractIconBase64(ico);
                        if (b64 != null) return b64;
                    }
                }
                string firstB64 = ExtractIconBase64(icos[0]);
                if (firstB64 != null) return firstB64;
            }

            // 2. Look for .exe files in root of install directory
            string[] exes = Directory.GetFiles(full, "*.exe");
            if (exes.Length > 0) {
                string dirName = Path.GetFileName(full);
                foreach (string exe in exes) {
                    string name = Path.GetFileNameWithoutExtension(exe);
                    if ((!string.IsNullOrEmpty(appName) && name.IndexOf(appName, StringComparison.OrdinalIgnoreCase) >= 0) ||
                        (!string.IsNullOrEmpty(dirName) && name.Equals(dirName, StringComparison.OrdinalIgnoreCase))) {
                        string b64 = ExtractIconBase64(exe);
                        if (b64 != null) return b64;
                    }
                }
                foreach (string exe in exes) {
                    string name = Path.GetFileNameWithoutExtension(exe);
                    if (name.IndexOf("unins", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        name.IndexOf("setup", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                    string b64 = ExtractIconBase64(exe);
                    if (b64 != null) return b64;
                }
            }
        } catch { }
        return null;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Auto)]
    static extern uint ExtractIconEx(string szFileName, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool DestroyIcon(IntPtr hIcon);

    public static string ExtractIconBase64(string rawPath) {
        if (string.IsNullOrWhiteSpace(rawPath)) return null;
        try {
            string clean = rawPath.Trim().Trim('"', '\'');
            int iconIndex = 0;
            int comma = clean.LastIndexOf(',');
            if (comma > 0) {
                string after = clean.Substring(comma + 1).Trim();
                int idx;
                if (int.TryParse(after, out idx)) {
                    iconIndex = idx;
                    clean = clean.Substring(0, comma).Trim().Trim('"', '\'');
                }
            }
            if (!File.Exists(clean)) return null;
            string ext = Path.GetExtension(clean).ToLowerInvariant();

            if (ext == ".png") {
                using (Image img = Image.FromFile(clean)) {
                    if (img.Width <= 48 && img.Height <= 48) {
                        return Convert.ToBase64String(File.ReadAllBytes(clean));
                    }
                    using (Bitmap bmp = new Bitmap(48, 48)) {
                        using (Graphics g = Graphics.FromImage(bmp)) {
                            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                            g.DrawImage(img, 0, 0, 48, 48);
                        }
                        using (MemoryStream ms = new MemoryStream()) {
                            bmp.Save(ms, ImageFormat.Png);
                            return Convert.ToBase64String(ms.ToArray());
                        }
                    }
                }
            }

            if (ext == ".ico" && iconIndex == 0) {
                using (Icon ico = new Icon(clean))
                using (Bitmap bmp = ico.ToBitmap())
                using (MemoryStream ms = new MemoryStream()) {
                    bmp.Save(ms, ImageFormat.Png);
                    return Convert.ToBase64String(ms.ToArray());
                }
            }

            IntPtr[] large = new IntPtr[1];
            IntPtr[] small = new IntPtr[1];
            uint count = ExtractIconEx(clean, iconIndex, large, small, 1);
            IntPtr hIcon = large[0] != IntPtr.Zero ? large[0] : small[0];

            if (hIcon == IntPtr.Zero && ext == ".exe") {
                using (Icon ico = Icon.ExtractAssociatedIcon(clean)) {
                    if (ico != null) {
                        using (Bitmap bmp = ico.ToBitmap())
                        using (MemoryStream ms = new MemoryStream()) {
                            bmp.Save(ms, ImageFormat.Png);
                            return Convert.ToBase64String(ms.ToArray());
                        }
                    }
                }
            }

            if (hIcon != IntPtr.Zero) {
                try {
                    using (Icon ico = Icon.FromHandle(hIcon))
                    using (Bitmap bmp = ico.ToBitmap())
                    using (MemoryStream ms = new MemoryStream()) {
                        bmp.Save(ms, ImageFormat.Png);
                        return Convert.ToBase64String(ms.ToArray());
                    }
                } finally {
                    if (large[0] != IntPtr.Zero) DestroyIcon(large[0]);
                    if (small[0] != IntPtr.Zero) DestroyIcon(small[0]);
                }
            }
        } catch { }
        return null;
    }

    public static string ExtractExecutablePath(string command) {
        if (string.IsNullOrWhiteSpace(command)) return null;
        try {
            string trimmed = command.Trim();
            if (trimmed.StartsWith("\"")) {
                int next = trimmed.IndexOf('"', 1);
                if (next > 1) {
                    string candidate = trimmed.Substring(1, next - 1).Trim();
                    if (File.Exists(candidate)) return candidate;
                }
            }
            if (File.Exists(trimmed)) return trimmed;
            int space = trimmed.IndexOf(' ');
            while (space > 0) {
                string candidate = trimmed.Substring(0, space).Trim('"', '\'');
                if (File.Exists(candidate)) return candidate;
                space = trimmed.IndexOf(' ', space + 1);
            }
        } catch { }
        return null;
    }

    public static bool GetExecutableInfo(string filePath, out string description, out string company) {
        description = null;
        company = null;
        if (string.IsNullOrWhiteSpace(filePath)) return false;
        try {
            if (!File.Exists(filePath)) return false;
            System.Diagnostics.FileVersionInfo vi = System.Diagnostics.FileVersionInfo.GetVersionInfo(filePath);
            description = !string.IsNullOrWhiteSpace(vi.FileDescription) ? vi.FileDescription.Trim() : (!string.IsNullOrWhiteSpace(vi.ProductName) ? vi.ProductName.Trim() : null);
            company = !string.IsNullOrWhiteSpace(vi.CompanyName) ? vi.CompanyName.Trim() : null;
            return true;
        } catch {
            return false;
        }
    }
}

