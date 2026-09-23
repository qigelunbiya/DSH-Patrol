param(
  [Parameter(Mandatory=$true)][string]$Action,
  [Parameter(Mandatory=$true)][string]$Payload
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('PatrolDesktop.Native' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
namespace PatrolDesktop {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out RECT rect, int cbAttribute);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  }
}
"@
}


if (-not ('PatrolDesktopVision.Engine' -as [type])) {
  Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace PatrolDesktopVision {
  public sealed class CandidateDto {
    public string CandidateId;
    public int Left;
    public int Top;
    public int Width;
    public int Height;
    public double LeftRatio;
    public double TopRatio;
    public double WidthRatio;
    public double HeightRatio;
    public double CenterXRatio;
    public double CenterYRatio;
    public double Score;
  }

  public sealed class ActionMapResult {
    public CandidateDto[] Candidates;
    public int SourceWidth;
    public int SourceHeight;
    public int CropX;
    public int CropY;
    public int CropWidth;
    public int CropHeight;
    public int MapWidth;
    public int MapHeight;
    public string Path;
  }

  public sealed class MatchResult {
    public bool Matched;
    public double Score;
    public int Left;
    public int Top;
    public int Width;
    public int Height;
    public double CenterXRatio;
    public double CenterYRatio;
    public double Scale;
  }

  public static class Engine {
    static int Clamp(int value, int min, int max) {
      return value < min ? min : (value > max ? max : value);
    }

    static Bitmap Load24(string path) {
      using (Bitmap source = new Bitmap(path)) {
        Bitmap copy = new Bitmap(source.Width, source.Height, PixelFormat.Format24bppRgb);
        using (Graphics g = Graphics.FromImage(copy)) {
          g.DrawImage(source, 0, 0, source.Width, source.Height);
        }
        return copy;
      }
    }

    static byte[] Gray(Bitmap bitmap) {
      Rectangle rect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
      BitmapData data = bitmap.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
      try {
        int stride = Math.Abs(data.Stride);
        byte[] raw = new byte[stride * bitmap.Height];
        Marshal.Copy(data.Scan0, raw, 0, raw.Length);
        byte[] gray = new byte[bitmap.Width * bitmap.Height];
        for (int y = 0; y < bitmap.Height; y++) {
          int row = y * stride;
          for (int x = 0; x < bitmap.Width; x++) {
            int p = row + x * 3;
            int b = raw[p];
            int g = raw[p + 1];
            int r = raw[p + 2];
            gray[y * bitmap.Width + x] = (byte)((r * 77 + g * 150 + b * 29) >> 8);
          }
        }
        return gray;
      } finally {
        bitmap.UnlockBits(data);
      }
    }

    static Bitmap CropAndScale(Bitmap source, Rectangle crop, int maxSide, bool upscale) {
      double scale = Math.Min(maxSide / (double)crop.Width, maxSide / (double)crop.Height);
      if (!upscale && scale > 1.0) scale = 1.0;
      if (upscale && scale > 3.0) scale = 3.0;
      int width = Math.Max(1, (int)Math.Round(crop.Width * scale));
      int height = Math.Max(1, (int)Math.Round(crop.Height * scale));
      Bitmap output = new Bitmap(width, height, PixelFormat.Format24bppRgb);
      using (Graphics g = Graphics.FromImage(output)) {
        g.Clear(Color.White);
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImage(source, new Rectangle(0, 0, width, height), crop, GraphicsUnit.Pixel);
      }
      return output;
    }

    static double IoU(CandidateDto a, CandidateDto b) {
      int left = Math.Max(a.Left, b.Left);
      int top = Math.Max(a.Top, b.Top);
      int right = Math.Min(a.Left + a.Width, b.Left + b.Width);
      int bottom = Math.Min(a.Top + a.Height, b.Top + b.Height);
      if (right <= left || bottom <= top) return 0.0;
      double inter = (right - left) * (double)(bottom - top);
      double union = a.Width * (double)a.Height + b.Width * (double)b.Height - inter;
      return union <= 0 ? 0 : inter / union;
    }

    public static ActionMapResult BuildActionMap(
      string sourcePath,
      string outputPath,
      double cropXRatio,
      double cropYRatio,
      double cropWidthRatio,
      double cropHeightRatio,
      int maxCandidates
    ) {
      using (Bitmap source = Load24(sourcePath)) {
        int sx = Clamp((int)Math.Floor(source.Width * cropXRatio), 0, source.Width - 1);
        int sy = Clamp((int)Math.Floor(source.Height * cropYRatio), 0, source.Height - 1);
        int sr = Clamp((int)Math.Ceiling(source.Width * (cropXRatio + cropWidthRatio)), sx + 1, source.Width);
        int sb = Clamp((int)Math.Ceiling(source.Height * (cropYRatio + cropHeightRatio)), sy + 1, source.Height);
        Rectangle crop = new Rectangle(sx, sy, sr - sx, sb - sy);

        using (Bitmap work = CropAndScale(source, crop, 768, false)) {
          int w = work.Width;
          int h = work.Height;
          byte[] gray = Gray(work);
          bool[] edge = new bool[w * h];
          const int threshold = 30;
          for (int y = 1; y < h - 1; y++) {
            int row = y * w;
            for (int x = 1; x < w - 1; x++) {
              int i = row + x;
              int g = gray[i];
              int d1 = Math.Abs(g - gray[i - 1]);
              int d2 = Math.Abs(g - gray[i + 1]);
              int d3 = Math.Abs(g - gray[i - w]);
              int d4 = Math.Abs(g - gray[i + w]);
              edge[i] = Math.Max(Math.Max(d1, d2), Math.Max(d3, d4)) >= threshold;
            }
          }

          for (int pass = 0; pass < 2; pass++) {
            bool[] expanded = (bool[])edge.Clone();
            for (int y = 1; y < h - 1; y++) {
              int row = y * w;
              for (int x = 1; x < w - 1; x++) {
                int i = row + x;
                if (!edge[i]) continue;
                expanded[i - 1] = true;
                expanded[i + 1] = true;
                expanded[i - w] = true;
                expanded[i + w] = true;
                expanded[i - w - 1] = true;
                expanded[i - w + 1] = true;
                expanded[i + w - 1] = true;
                expanded[i + w + 1] = true;
              }
            }
            edge = expanded;
          }

          bool[] visited = new bool[w * h];
          int[] queue = new int[w * h];
          List<CandidateDto> raw = new List<CandidateDto>();
          double scaleX = crop.Width / (double)w;
          double scaleY = crop.Height / (double)h;

          for (int y0 = 1; y0 < h - 1; y0++) {
            for (int x0 = 1; x0 < w - 1; x0++) {
              int seed = y0 * w + x0;
              if (!edge[seed] || visited[seed]) continue;
              int head = 0;
              int tail = 0;
              queue[tail++] = seed;
              visited[seed] = true;
              int minX = x0, maxX = x0, minY = y0, maxY = y0, count = 0;

              while (head < tail) {
                int i = queue[head++];
                int y = i / w;
                int x = i - y * w;
                count++;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                int[] neighbors = { i - 1, i + 1, i - w, i + w };
                for (int n = 0; n < 4; n++) {
                  int ni = neighbors[n];
                  if (ni < 0 || ni >= edge.Length || visited[ni] || !edge[ni]) continue;
                  int ny = ni / w;
                  int nx = ni - ny * w;
                  if (nx <= 0 || nx >= w - 1 || ny <= 0 || ny >= h - 1) continue;
                  visited[ni] = true;
                  queue[tail++] = ni;
                }
              }

              int bw = maxX - minX + 1;
              int bh = maxY - minY + 1;
              int area = bw * bh;
              if (count < 12 || bw < 5 || bh < 5) continue;
              if (bw > w * 0.48 || bh > h * 0.48 || area > w * h * 0.20) continue;
              double aspect = bw / (double)bh;
              if (aspect < 0.12 || aspect > 8.0) continue;

              int pad = Math.Max(3, Math.Min(8, Math.Max(bw, bh) / 8));
              minX = Math.Max(0, minX - pad);
              minY = Math.Max(0, minY - pad);
              maxX = Math.Min(w - 1, maxX + pad);
              maxY = Math.Min(h - 1, maxY + pad);
              bw = maxX - minX + 1;
              bh = maxY - minY + 1;

              int left = crop.X + (int)Math.Round(minX * scaleX);
              int top = crop.Y + (int)Math.Round(minY * scaleY);
              int width = Math.Max(1, (int)Math.Round(bw * scaleX));
              int height = Math.Max(1, (int)Math.Round(bh * scaleY));
              if (left + width > source.Width) width = source.Width - left;
              if (top + height > source.Height) height = source.Height - top;

              CandidateDto candidate = new CandidateDto();
              candidate.Left = left;
              candidate.Top = top;
              candidate.Width = width;
              candidate.Height = height;
              candidate.LeftRatio = left / (double)source.Width;
              candidate.TopRatio = top / (double)source.Height;
              candidate.WidthRatio = width / (double)source.Width;
              candidate.HeightRatio = height / (double)source.Height;
              candidate.CenterXRatio = (left + width / 2.0) / source.Width;
              candidate.CenterYRatio = (top + height / 2.0) / source.Height;
              candidate.Score = count / Math.Sqrt(Math.Max(1.0, area));
              raw.Add(candidate);
            }
          }

          raw.Sort(delegate(CandidateDto a, CandidateDto b) {
            int score = b.Score.CompareTo(a.Score);
            if (score != 0) return score;
            int top = a.Top.CompareTo(b.Top);
            return top != 0 ? top : a.Left.CompareTo(b.Left);
          });

          List<CandidateDto> selected = new List<CandidateDto>();
          for (int i = 0; i < raw.Count && selected.Count < Math.Max(1, maxCandidates); i++) {
            CandidateDto item = raw[i];
            bool overlap = false;
            for (int j = 0; j < selected.Count; j++) {
              if (IoU(item, selected[j]) > 0.42) { overlap = true; break; }
            }
            if (!overlap) selected.Add(item);
          }
          selected.Sort(delegate(CandidateDto a, CandidateDto b) {
            int top = a.Top.CompareTo(b.Top);
            return top != 0 ? top : a.Left.CompareTo(b.Left);
          });
          for (int i = 0; i < selected.Count; i++) selected[i].CandidateId = "D" + (i + 1).ToString();

          int mapMax = 900;
          double mapScale = Math.Min(mapMax / (double)crop.Width, mapMax / (double)crop.Height);
          if (mapScale > 2.5) mapScale = 2.5;
          int mapWidth = Math.Max(1, (int)Math.Round(crop.Width * mapScale));
          int mapHeight = Math.Max(1, (int)Math.Round(crop.Height * mapScale));
          using (Bitmap map = new Bitmap(mapWidth, mapHeight, PixelFormat.Format24bppRgb)) {
            using (Graphics g = Graphics.FromImage(map)) {
              g.InterpolationMode = InterpolationMode.HighQualityBicubic;
              g.DrawImage(source, new Rectangle(0, 0, mapWidth, mapHeight), crop, GraphicsUnit.Pixel);
              using (Pen pen = new Pen(Color.FromArgb(240, 255, 45, 45), 2.0f))
              using (Pen centerPen = new Pen(Color.FromArgb(240, 0, 255, 110), 2.0f))
              using (SolidBrush labelBg = new SolidBrush(Color.FromArgb(220, 200, 0, 0)))
              using (SolidBrush labelText = new SolidBrush(Color.White))
              using (Font font = new Font("Arial", 12.0f, FontStyle.Bold, GraphicsUnit.Pixel)) {
                for (int i = 0; i < selected.Count; i++) {
                  CandidateDto item = selected[i];
                  float x = (float)((item.Left - crop.X) * mapScale);
                  float y = (float)((item.Top - crop.Y) * mapScale);
                  float ww = Math.Max(2.0f, (float)(item.Width * mapScale));
                  float hh = Math.Max(2.0f, (float)(item.Height * mapScale));
                  g.DrawRectangle(pen, x, y, ww, hh);
                  float cx = x + ww / 2.0f;
                  float cy = y + hh / 2.0f;
                  g.DrawLine(centerPen, cx - 5, cy, cx + 5, cy);
                  g.DrawLine(centerPen, cx, cy - 5, cx, cy + 5);
                  string label = item.CandidateId;
                  SizeF size = g.MeasureString(label, font);
                  g.FillRectangle(labelBg, x, Math.Max(0, y - size.Height - 2), size.Width + 5, size.Height + 2);
                  g.DrawString(label, font, labelText, x + 2, Math.Max(0, y - size.Height - 1));
                }
              }
            }
            string dir = System.IO.Path.GetDirectoryName(outputPath);
            if (!String.IsNullOrEmpty(dir)) System.IO.Directory.CreateDirectory(dir);
            map.Save(outputPath, ImageFormat.Jpeg);
          }

          ActionMapResult result = new ActionMapResult();
          result.Candidates = selected.ToArray();
          result.SourceWidth = source.Width;
          result.SourceHeight = source.Height;
          result.CropX = crop.X;
          result.CropY = crop.Y;
          result.CropWidth = crop.Width;
          result.CropHeight = crop.Height;
          result.MapWidth = mapWidth;
          result.MapHeight = mapHeight;
          result.Path = outputPath;
          return result;
        }
      }
    }

    static Bitmap ResizeTemplate(Bitmap source, double scale) {
      int width = Math.Max(3, (int)Math.Round(source.Width * scale));
      int height = Math.Max(3, (int)Math.Round(source.Height * scale));
      Bitmap output = new Bitmap(width, height, PixelFormat.Format24bppRgb);
      using (Graphics g = Graphics.FromImage(output)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.DrawImage(source, 0, 0, width, height);
      }
      return output;
    }

    public static MatchResult MatchTemplate(
      string sourcePath,
      string templatePath,
      double expectedXRatio,
      double expectedYRatio,
      double searchWidthRatio,
      double searchHeightRatio
    ) {
      using (Bitmap source = Load24(sourcePath))
      using (Bitmap templateBase = Load24(templatePath)) {
        byte[] sourceGray = Gray(source);
        int sw = source.Width;
        int sh = source.Height;
        int searchWidth = Math.Max(templateBase.Width + 2, (int)Math.Round(sw * searchWidthRatio));
        int searchHeight = Math.Max(templateBase.Height + 2, (int)Math.Round(sh * searchHeightRatio));
        int centerX = Clamp((int)Math.Round(sw * expectedXRatio), 0, sw - 1);
        int centerY = Clamp((int)Math.Round(sh * expectedYRatio), 0, sh - 1);
        int searchLeft = Clamp(centerX - searchWidth / 2, 0, Math.Max(0, sw - 1));
        int searchTop = Clamp(centerY - searchHeight / 2, 0, Math.Max(0, sh - 1));
        int searchRight = Clamp(searchLeft + searchWidth, 1, sw);
        int searchBottom = Clamp(searchTop + searchHeight, 1, sh);

        double bestScore = -1.0;
        int bestX = 0, bestY = 0, bestW = 0, bestH = 0;
        double bestScale = 1.0;
        double[] scales = { 0.90, 1.0, 1.10 };

        for (int si = 0; si < scales.Length; si++) {
          using (Bitmap template = ResizeTemplate(templateBase, scales[si])) {
            int tw = template.Width;
            int th = template.Height;
            if (tw >= searchRight - searchLeft || th >= searchBottom - searchTop) continue;
            byte[] templateGray = Gray(template);
            int sampleStep = Math.Max(1, Math.Min(tw, th) / 24);
            int samples = 0;
            for (int ty = 0; ty < th; ty += sampleStep) {
              for (int tx = 0; tx < tw; tx += sampleStep) samples++;
            }
            if (samples <= 0) continue;

            for (int y = searchTop; y <= searchBottom - th; y++) {
              for (int x = searchLeft; x <= searchRight - tw; x++) {
                long sad = 0;
                for (int ty = 0; ty < th; ty += sampleStep) {
                  int sourceRow = (y + ty) * sw + x;
                  int templateRow = ty * tw;
                  for (int tx = 0; tx < tw; tx += sampleStep) {
                    sad += Math.Abs(sourceGray[sourceRow + tx] - templateGray[templateRow + tx]);
                  }
                }
                double score = 1.0 - (sad / (samples * 255.0));
                if (score > bestScore) {
                  bestScore = score;
                  bestX = x;
                  bestY = y;
                  bestW = tw;
                  bestH = th;
                  bestScale = scales[si];
                }
              }
            }
          }
        }

        MatchResult result = new MatchResult();
        result.Matched = bestScore >= 0;
        result.Score = bestScore;
        result.Left = bestX;
        result.Top = bestY;
        result.Width = bestW;
        result.Height = bestH;
        result.CenterXRatio = bestW > 0 ? (bestX + bestW / 2.0) / sw : expectedXRatio;
        result.CenterYRatio = bestH > 0 ? (bestY + bestH / 2.0) / sh : expectedYRatio;
        result.Scale = bestScale;
        return result;
      }
    }
  }
}
"@
}

try {
  if (-not [PatrolDesktop.Native]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
    [void][PatrolDesktop.Native]::SetProcessDPIAware()
  }
} catch {
  try { [void][PatrolDesktop.Native]::SetProcessDPIAware() } catch {}
}

function Decode-Payload([string]$value) {
  $bytes = [Convert]::FromBase64String($value)
  $json = [Text.Encoding]::UTF8.GetString($bytes)
  if ([string]::IsNullOrWhiteSpace($json)) { return [pscustomobject]@{} }
  return $json | ConvertFrom-Json
}

function Get-Prop($obj, [string]$name, $default = $null) {
  if ($null -eq $obj) { return $default }
  $prop = $obj.PSObject.Properties[$name]
  if ($null -eq $prop) { return $default }
  return $prop.Value
}

function Get-VisualWindowRect($process) {
  if ($null -eq $process -or $process.MainWindowHandle -eq 0) { throw 'window has no main handle' }
  $rect = New-Object PatrolDesktop.Native+RECT
  $source = 'get-window-rect'
  $valid = $false
  try {
    $size = [Runtime.InteropServices.Marshal]::SizeOf($rect)
    $hr = [PatrolDesktop.Native]::DwmGetWindowAttribute([IntPtr]$process.MainWindowHandle, 9, [ref]$rect, $size)
    if ($hr -eq 0 -and $rect.Right -gt $rect.Left -and $rect.Bottom -gt $rect.Top) {
      $source = 'dwm-extended-frame'
      $valid = $true
    }
  } catch {}
  if (-not $valid) {
    if (-not [PatrolDesktop.Native]::GetWindowRect([IntPtr]$process.MainWindowHandle, [ref]$rect)) {
      throw 'GetWindowRect failed'
    }
  }
  return [ordered]@{
    x = [int]$rect.Left
    y = [int]$rect.Top
    width = [int]($rect.Right - $rect.Left)
    height = [int]($rect.Bottom - $rect.Top)
    source = $source
  }
}

function Window-Record($process) {
  if ($null -eq $process -or $process.MainWindowHandle -eq 0) { return $null }
  $visualRect = Get-VisualWindowRect $process
  return [ordered]@{
    processId = [int]$process.Id
    processName = [string]$process.ProcessName
    title = [string]$process.MainWindowTitle
    hwnd = [int64]$process.MainWindowHandle
    rect = [ordered]@{
      x = [int]$visualRect.x
      y = [int]$visualRect.y
      width = [int]$visualRect.width
      height = [int]$visualRect.height
    }
    rectSource = [string]$visualRect.source
  }
}

function Get-Windows {
  $items = @()
  foreach ($process in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) })) {
    $record = Window-Record $process
    if ($null -ne $record) { $items += $record }
  }
  return $items
}

function Resolve-Window($request, [bool]$allowForeground = $true) {
  $processId = Get-Prop $request 'processId'
  $hwnd = Get-Prop $request 'hwnd'
  $processName = [string](Get-Prop $request 'processName' '')
  $title = [string](Get-Prop $request 'title' '')
  $titleContains = [string](Get-Prop $request 'titleContains' '')

  if ($null -ne $hwnd -and [int64]$hwnd -ne 0) {
    $p = Get-Process | Where-Object { $_.MainWindowHandle -eq [int64]$hwnd } | Select-Object -First 1
    if ($null -eq $p) { throw "desktop window hwnd=$hwnd not found" }
    return $p
  }
  if ($null -ne $processId) {
    $p = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
    if ($null -eq $p -or $p.MainWindowHandle -eq 0) { throw "desktop processId=$processId has no main window" }
    return $p
  }

  $windows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) })
  if (-not [string]::IsNullOrWhiteSpace($processName)) {
    $windows = @($windows | Where-Object { $_.ProcessName -ieq $processName })
  }
  if (-not [string]::IsNullOrWhiteSpace($title)) {
    $windows = @($windows | Where-Object { $_.MainWindowTitle -ieq $title })
  } elseif (-not [string]::IsNullOrWhiteSpace($titleContains)) {
    $windows = @($windows | Where-Object { $_.MainWindowTitle.IndexOf($titleContains, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  }

  if ($windows.Count -eq 1) { return $windows[0] }
  if ($windows.Count -gt 1) {
    $titles = ($windows | Select-Object -First 6 | ForEach-Object { "$($_.ProcessName):$($_.MainWindowTitle)" }) -join ' | '
    throw "desktop window query is ambiguous ($($windows.Count) matches): $titles"
  }

  if ($allowForeground -and [string]::IsNullOrWhiteSpace($processName) -and [string]::IsNullOrWhiteSpace($title) -and [string]::IsNullOrWhiteSpace($titleContains)) {
    $foreground = [PatrolDesktop.Native]::GetForegroundWindow()
    if ($foreground -eq [IntPtr]::Zero) { throw 'no foreground desktop window is available' }
    $p = Get-Process | Where-Object { $_.MainWindowHandle -eq [int64]$foreground } | Select-Object -First 1
    if ($null -ne $p) { return $p }
  }

  throw 'desktop window not found; call desktop_list_windows and use processName/titleContains'
}

function Activate-Window($process) {
  if ($null -eq $process -or $process.MainWindowHandle -eq 0) { throw 'window has no main handle' }
  $target = [IntPtr]$process.MainWindowHandle
  [void][PatrolDesktop.Native]::ShowWindowAsync($target, 9)
  Start-Sleep -Milliseconds 80
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    [void][PatrolDesktop.Native]::SetForegroundWindow($target)
    Start-Sleep -Milliseconds 120
    $foreground = [PatrolDesktop.Native]::GetForegroundWindow()
    if ($foreground -eq $target) { return }
  }
  $foreground = [PatrolDesktop.Native]::GetForegroundWindow()
  $actual = Get-Process | Where-Object { $_.MainWindowHandle -eq [int64]$foreground } | Select-Object -First 1
  $actualLabel = if ($null -eq $actual) { [string][int64]$foreground } else { "$($actual.ProcessName):$($actual.MainWindowTitle)" }
  throw "failed to verify foreground desktop window $($process.ProcessName):$($process.MainWindowTitle); actual=$actualLabel"
}

function Get-Root($request) {
  $process = Resolve-Window $request $true
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$process.MainWindowHandle)
  if ($null -eq $root) { throw "UI Automation root unavailable for $($process.MainWindowTitle)" }
  return [pscustomobject]@{ Process = $process; Root = $root }
}

function Element-Record($element) {
  try {
    $current = $element.Current
    $rect = $current.BoundingRectangle
    $control = [string]$current.ControlType.ProgrammaticName
    if ($control.StartsWith('ControlType.')) { $control = $control.Substring(12) }
    $isPassword = [bool]$current.IsPassword
    $value = $null
    if (-not $isPassword) {
      $valuePattern = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        try {
          $rawValue = [string]([System.Windows.Automation.ValuePattern]$valuePattern).Current.Value
          $value = if ($rawValue.Length -le 2000) { $rawValue } else { $rawValue.Substring(0, 2000) + '...' }
        } catch {}
      }
    }
    return [ordered]@{
      name = [string]$current.Name
      automationId = [string]$current.AutomationId
      controlType = $control
      className = [string]$current.ClassName
      isPassword = $isPassword
      value = $value
      enabled = [bool]$current.IsEnabled
      offscreen = [bool]$current.IsOffscreen
      rect = [ordered]@{
        x = [int][Math]::Round($rect.X)
        y = [int][Math]::Round($rect.Y)
        width = [int][Math]::Round($rect.Width)
        height = [int][Math]::Round($rect.Height)
      }
    }
  } catch {
    return $null
  }
}

function Get-Snapshot($request) {
  $resolved = Get-Root $request
  $maxElements = [int](Get-Prop $request 'maxElements' 300)
  if ($maxElements -lt 1) { $maxElements = 1 }
  if ($maxElements -gt 1000) { $maxElements = 1000 }
  $includeOffscreen = [bool](Get-Prop $request 'includeOffscreen' $false)
  $all = $resolved.Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $items = @()
  for ($i = 0; $i -lt $all.Count -and $items.Count -lt $maxElements; $i++) {
    $record = Element-Record $all.Item($i)
    if ($null -eq $record) { continue }
    if (-not $includeOffscreen -and $record.offscreen) { continue }
    if ($record.rect.width -le 0 -or $record.rect.height -le 0) { continue }
    if ([string]::IsNullOrWhiteSpace($record.name) -and [string]::IsNullOrWhiteSpace($record.automationId)) {
      $interactiveTypes = @('Button','Edit','ListItem','MenuItem','TabItem','TreeItem','Hyperlink','CheckBox','RadioButton','ComboBox','DataItem')
      if ($interactiveTypes -notcontains $record.controlType) { continue }
    }
    $items += $record
  }
  return [ordered]@{
    ok = $true
    window = Window-Record $resolved.Process
    elements = $items
    truncated = ($all.Count -gt $items.Count)
  }
}

function Find-TargetElement($request) {
  $resolved = Get-Root $request
  $name = [string](Get-Prop $request 'name' '')
  $automationId = [string](Get-Prop $request 'automationId' '')
  $controlType = [string](Get-Prop $request 'controlType' '')
  $className = [string](Get-Prop $request 'className' '')
  $match = [string](Get-Prop $request 'match' 'exact')
  $indexValue = Get-Prop $request 'index' $null
  if ([string]::IsNullOrWhiteSpace($name) -and [string]::IsNullOrWhiteSpace($automationId) -and [string]::IsNullOrWhiteSpace($controlType) -and [string]::IsNullOrWhiteSpace($className)) {
    throw 'desktop target requires at least one of name, automationId, controlType, className'
  }

  $all = $resolved.Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $matches = @()
  for ($i = 0; $i -lt $all.Count; $i++) {
    $element = $all.Item($i)
    $record = Element-Record $element
    if ($null -eq $record -or $record.offscreen -or -not $record.enabled) { continue }
    if ($record.rect.width -le 0 -or $record.rect.height -le 0) { continue }
    if (-not [string]::IsNullOrWhiteSpace($automationId) -and $record.automationId -ine $automationId) { continue }
    if (-not [string]::IsNullOrWhiteSpace($controlType) -and $record.controlType -ine $controlType) { continue }
    if (-not [string]::IsNullOrWhiteSpace($className) -and $record.className -ine $className) { continue }
    if (-not [string]::IsNullOrWhiteSpace($name)) {
      $matched = if ($match -ieq 'contains') {
        $record.name.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0
      } else {
        $record.name -ieq $name
      }
      if (-not $matched) { continue }
    }
    $matches += [pscustomobject]@{ Element = $element; Record = $record }
  }

  if ($null -ne $indexValue) {
    $index = [int]$indexValue
    if ($index -lt 0 -or $index -ge $matches.Count) { throw "desktop target index $index is out of range; matches=$($matches.Count)" }
    return $matches[$index]
  }
  if ($matches.Count -eq 0) { throw "desktop target not found: name='$name' automationId='$automationId' controlType='$controlType' className='$className'" }
  if ($matches.Count -ne 1) {
    $sample = ($matches | Select-Object -First 6 | ForEach-Object { "$($_.Record.controlType):$($_.Record.name):$($_.Record.automationId)" }) -join ' | '
    throw "desktop target is ambiguous ($($matches.Count) matches): $sample"
  }
  return $matches[0]
}

function Click-Point([int]$x, [int]$y, [int]$button = 0) {
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
  Start-Sleep -Milliseconds 40
  if ($button -eq 1) {
    [PatrolDesktop.Native]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
    [PatrolDesktop.Native]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
  } else {
    [PatrolDesktop.Native]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [PatrolDesktop.Native]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
}

function Invoke-Target($target) {
  $element = $target.Element
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
    return 'invoke-pattern'
  }
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
    ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
    return 'selection-item-pattern'
  }
  $rect = $target.Record.rect
  $x = [int]($rect.x + [Math]::Max(1, [Math]::Floor($rect.width / 2)))
  $y = [int]($rect.y + [Math]::Max(1, [Math]::Floor($rect.height / 2)))
  Click-Point $x $y 0
  return 'bounding-rect-click'
}

function Focus-Target($target) {
  try {
    $target.Element.SetFocus()
    Start-Sleep -Milliseconds 80
    return 'uia-set-focus'
  } catch {
    $rect = $target.Record.rect
    $x = [int]($rect.x + [Math]::Max(1, [Math]::Floor($rect.width / 2)))
    $y = [int]($rect.y + [Math]::Max(1, [Math]::Floor($rect.height / 2)))
    Click-Point $x $y 0
    Start-Sleep -Milliseconds 80
    return 'bounding-rect-click'
  }
}

function Activate-RequestedWindow($request) {
  $hasSelector = @('processId','hwnd','processName','title','titleContains') | Where-Object {
    $value = Get-Prop $request $_ $null
    if ($null -eq $value) { return $false }
    if ($value -is [string]) { return -not [string]::IsNullOrWhiteSpace([string]$value) }
    return $true
  }
  if ($hasSelector.Count -eq 0) { return $null }
  $process = Resolve-Window $request $false
  Activate-Window $process
  return Window-Record $process
}

function Send-Key([string]$key) {
  $map = @{
    'ENTER'='{ENTER}'; 'RETURN'='{ENTER}'; 'ESC'='{ESC}'; 'ESCAPE'='{ESC}';
    'TAB'='{TAB}'; 'BACKSPACE'='{BACKSPACE}'; 'BS'='{BACKSPACE}'; 'DELETE'='{DELETE}';
    'DEL'='{DELETE}'; 'UP'='{UP}'; 'DOWN'='{DOWN}'; 'LEFT'='{LEFT}'; 'RIGHT'='{RIGHT}';
    'HOME'='{HOME}'; 'END'='{END}'; 'PGUP'='{PGUP}'; 'PGDN'='{PGDN}'; 'SPACE'=' ';
  }
  $upper = $key.ToUpperInvariant()
  if ($map.ContainsKey($upper)) { [System.Windows.Forms.SendKeys]::SendWait($map[$upper]); return }
  if ($upper -match '^F([1-9]|1[0-2])$') { [System.Windows.Forms.SendKeys]::SendWait("{$upper}"); return }
  if ($key.Length -eq 1) { [System.Windows.Forms.SendKeys]::SendWait($key); return }
  throw "unsupported desktop key '$key'"
}

function Send-Hotkey([string]$combo) {
  $parts = @($combo.Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($parts.Count -lt 2) { Send-Key $combo; return }
  $prefix = ''
  for ($i = 0; $i -lt $parts.Count - 1; $i++) {
    switch -Regex ($parts[$i].ToUpperInvariant()) {
      '^CTRL|CONTROL$' { $prefix += '^'; break }
      '^ALT$' { $prefix += '%'; break }
      '^SHIFT$' { $prefix += '+'; break }
      default { throw "unsupported desktop hotkey modifier '$($parts[$i])'; supported: Ctrl, Alt, Shift" }
    }
  }
  $key = $parts[$parts.Count - 1]
  $upper = $key.ToUpperInvariant()
  $special = @{
    'ENTER'='{ENTER}'; 'ESC'='{ESC}'; 'ESCAPE'='{ESC}'; 'TAB'='{TAB}'; 'DELETE'='{DELETE}';
    'UP'='{UP}'; 'DOWN'='{DOWN}'; 'LEFT'='{LEFT}'; 'RIGHT'='{RIGHT}'; 'HOME'='{HOME}'; 'END'='{END}';
  }
  if ($special.ContainsKey($upper)) { $encoded = $special[$upper] }
  elseif ($upper -match '^F([1-9]|1[0-2])$') { $encoded = "{$upper}" }
  elseif ($key.Length -eq 1) { $encoded = $key.ToLowerInvariant() }
  else { throw "unsupported desktop hotkey key '$key'" }
  [System.Windows.Forms.SendKeys]::SendWait("$prefix$encoded")
}

function Write-VisualGuideImage([string]$sourcePath, [string]$outputPath, $markXRatio = $null, $markYRatio = $null) {
  if (-not [IO.File]::Exists($sourcePath)) { throw "visual guide source image not found: $sourcePath" }
  $directory = [IO.Path]::GetDirectoryName($outputPath)
  if (-not [string]::IsNullOrWhiteSpace($directory)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }

  $source = [System.Drawing.Image]::FromFile($sourcePath)
  $bitmap = $null
  $graphics = $null
  $minorPen = $null
  $majorPen = $null
  $markerPen = $null
  $markerBrush = $null
  $font = $null
  $labelBrush = $null
  $labelBackground = $null
  try {
    $width = [int]$source.Width
    $height = [int]$source.Height
    if ($width -le 0 -or $height -le 0) { throw 'visual guide source image has invalid dimensions' }
    $bitmap = [System.Drawing.Bitmap]::new($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.DrawImage($source, 0, 0, $width, $height)

    $minorPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(36, 255, 255, 255), [single]1)
    $majorPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(82, 255, 64, 64), [single]1)
    for ($step = 50; $step -lt 1000; $step += 50) {
      $x = [single]($width * $step / 1000.0)
      $y = [single]($height * $step / 1000.0)
      $pen = $(if (($step % 100) -eq 0) { $majorPen } else { $minorPen })
      $graphics.DrawLine($pen, $x, [single]0, $x, [single]$height)
      $graphics.DrawLine($pen, [single]0, $y, [single]$width, $y)
    }

    $fontSize = [single][Math]::Max(9, [Math]::Min(14, [Math]::Round($width / 90.0)))
    $font = [System.Drawing.Font]::new('Arial', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $labelBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(245, 255, 255, 255))
    $labelBackground = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(175, 0, 0, 0))

    $labels = @()
    $labels += [pscustomobject]@{ text='XY/1000'; x=[single]3; y=[single]3 }
    for ($step = 100; $step -lt 1000; $step += 100) {
      $labels += [pscustomobject]@{ text=("X" + $step); x=[single]($width * $step / 1000.0 + 2); y=[single]2 }
      $labels += [pscustomobject]@{ text=("Y" + $step); x=[single]2; y=[single]($height * $step / 1000.0 + 2) }
    }
    foreach ($item in $labels) {
      $size = $graphics.MeasureString([string]$item.text, $font)
      $boxX = [single][Math]::Max(0, [double]$item.x - 2)
      $boxY = [single][Math]::Max(0, [double]$item.y - 1)
      $graphics.FillRectangle($labelBackground, $boxX, $boxY, [single]($size.Width + 6), [single]($size.Height + 3))
      $graphics.DrawString([string]$item.text, $font, $labelBrush, [single]$item.x, [single]$item.y)
    }

    if ($null -ne $markXRatio -and $null -ne $markYRatio) {
      $rx = [double]$markXRatio
      $ry = [double]$markYRatio
      if ($rx -lt 0 -or $rx -gt 1 -or $ry -lt 0 -or $ry -gt 1) { throw 'visual preview requires mark ratios between 0 and 1' }
      $mx = [single](($width - 1) * $rx)
      $my = [single](($height - 1) * $ry)
      $radius = [single][Math]::Max(7, [Math]::Round($width / 150.0))
      $markerPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 0, 255, 80), [single]3)
      $markerBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(180, 0, 255, 80))
      $graphics.DrawEllipse($markerPen, $mx - $radius, $my - $radius, $radius * 2, $radius * 2)
      $graphics.DrawLine($markerPen, $mx - $radius * 1.6, $my, $mx + $radius * 1.6, $my)
      $graphics.DrawLine($markerPen, $mx, $my - $radius * 1.6, $mx, $my + $radius * 1.6)
      $graphics.FillEllipse($markerBrush, $mx - 2, $my - 2, [single]4, [single]4)
    }

    $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    if ($markerBrush) { $markerBrush.Dispose() }
    if ($markerPen) { $markerPen.Dispose() }
    if ($labelBackground) { $labelBackground.Dispose() }
    if ($labelBrush) { $labelBrush.Dispose() }
    if ($font) { $font.Dispose() }
    if ($majorPen) { $majorPen.Dispose() }
    if ($minorPen) { $minorPen.Dispose() }
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
    if ($source) { $source.Dispose() }
  }
  return [ordered]@{ ok=$true; path=$outputPath; width=[int]$width; height=[int]$height; coordinateGridUnits=1000 }
}

function Write-ModelVisionImage(
  [string]$sourcePath,
  [string]$outputPath,
  [int]$maxWidth = 896,
  [int]$maxHeight = 896,
  [int]$jpegQuality = 68,
  [double]$cropXRatio = 0,
  [double]$cropYRatio = 0,
  [double]$cropWidthRatio = 1,
  [double]$cropHeightRatio = 1,
  [bool]$upscale = $false
) {
  if (-not [IO.File]::Exists($sourcePath)) { throw "model vision source image not found: $sourcePath" }
  if ($maxWidth -lt 64 -or $maxHeight -lt 64) { throw 'model vision max dimensions must be >= 64' }
  if ($cropXRatio -lt 0 -or $cropYRatio -lt 0 -or $cropWidthRatio -le 0 -or $cropHeightRatio -le 0 -or
      $cropXRatio + $cropWidthRatio -gt 1.000001 -or $cropYRatio + $cropHeightRatio -gt 1.000001) {
    throw 'model vision crop ratios must stay inside the source image'
  }

  $directory = [IO.Path]::GetDirectoryName($outputPath)
  if (-not [string]::IsNullOrWhiteSpace($directory)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }

  $source = [System.Drawing.Image]::FromFile($sourcePath)
  $bitmap = $null
  $graphics = $null
  $encoderParams = $null
  $qualityParam = $null
  try {
    $sourceWidth = [int]$source.Width
    $sourceHeight = [int]$source.Height
    $cropX = [int][Math]::Floor($sourceWidth * $cropXRatio)
    $cropY = [int][Math]::Floor($sourceHeight * $cropYRatio)
    $cropRight = [int][Math]::Ceiling($sourceWidth * ($cropXRatio + $cropWidthRatio))
    $cropBottom = [int][Math]::Ceiling($sourceHeight * ($cropYRatio + $cropHeightRatio))
    $cropRight = [Math]::Min($sourceWidth, [Math]::Max($cropX + 1, $cropRight))
    $cropBottom = [Math]::Min($sourceHeight, [Math]::Max($cropY + 1, $cropBottom))
    $cropWidth = [int]($cropRight - $cropX)
    $cropHeight = [int]($cropBottom - $cropY)

    $scale = [Math]::Min($maxWidth / [double]$cropWidth, $maxHeight / [double]$cropHeight)
    if (-not $upscale) { $scale = [Math]::Min(1.0, $scale) }
    else { $scale = [Math]::Min(3.5, $scale) }
    $targetWidth = [Math]::Max(1, [int][Math]::Round($cropWidth * $scale))
    $targetHeight = [Math]::Max(1, [int][Math]::Round($cropHeight * $scale))

    $bitmap = [System.Drawing.Bitmap]::new($targetWidth, $targetHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $dest = [System.Drawing.Rectangle]::new(0, 0, $targetWidth, $targetHeight)
    $graphics.DrawImage($source, $dest, $cropX, $cropY, $cropWidth, $cropHeight, [System.Drawing.GraphicsUnit]::Pixel)

    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    if ($null -eq $codec) {
      $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    } else {
      $encoderParams = [System.Drawing.Imaging.EncoderParameters]::new(1)
      $qualityParam = [System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality, [int64][Math]::Max(35, [Math]::Min(92, $jpegQuality)))
      $encoderParams.Param[0] = $qualityParam
      $bitmap.Save($outputPath, $codec, $encoderParams)
    }

    return [ordered]@{
      ok=$true
      path=$outputPath
      width=[int]$targetWidth
      height=[int]$targetHeight
      sourceWidth=[int]$sourceWidth
      sourceHeight=[int]$sourceHeight
      crop=[ordered]@{
        xRatio=[double]($cropX / [double]$sourceWidth)
        yRatio=[double]($cropY / [double]$sourceHeight)
        widthRatio=[double]($cropWidth / [double]$sourceWidth)
        heightRatio=[double]($cropHeight / [double]$sourceHeight)
      }
      jpegQuality=[int]$jpegQuality
    }
  } finally {
    if ($qualityParam) { $qualityParam.Dispose() }
    if ($encoderParams) { $encoderParams.Dispose() }
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
    if ($source) { $source.Dispose() }
  }
}
function Capture-Screenshot($request) {
  $path = [string](Get-Prop $request 'path' '')
  if ([string]::IsNullOrWhiteSpace($path)) { throw 'desktop screenshot path is required' }
  $scope = [string](Get-Prop $request 'scope' 'active-window')
  $captureMethod = [string](Get-Prop $request 'captureMethod' 'auto')
  if (@('auto','print-window','screen') -notcontains $captureMethod) { throw "unsupported desktop captureMethod '$captureMethod'" }
  $windowRecord = $null
  $process = $null
  if ($scope -ieq 'screen') {
    $captureMethod = 'screen'
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $x = $bounds.X; $y = $bounds.Y; $width = $bounds.Width; $height = $bounds.Height
  } else {
    $scope = 'active-window'
    $process = Resolve-Window $request $true
    Activate-Window $process
    $windowRecord = Window-Record $process
    $rect = $windowRecord.rect
    $x = [int]$rect.x; $y = [int]$rect.y; $width = [int]$rect.width; $height = [int]$rect.height
  }
  if ($width -le 0 -or $height -le 0) { throw "invalid screenshot bounds $width x $height" }
  $directory = [IO.Path]::GetDirectoryName($path)
  if (-not [string]::IsNullOrWhiteSpace($directory)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }

  if ($scope -eq 'active-window' -and $captureMethod -ne 'screen') {
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = [IntPtr]::Zero
    $printed = $false
    try {
      $hdc = $graphics.GetHdc()
      $printed = [PatrolDesktop.Native]::PrintWindow([IntPtr]$process.MainWindowHandle, $hdc, 2)
    } finally {
      if ($hdc -ne [IntPtr]::Zero) { $graphics.ReleaseHdc($hdc) }
      $graphics.Dispose()
    }
    if ($printed) {
      try { $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
      return [ordered]@{ ok=$true; path=$path; scope=$scope; captureMethod='print-window'; window=$windowRecord; x=[int]$x; y=[int]$y; width=[int]$width; height=[int]$height }
    }
    $bitmap.Dispose()
    if ($captureMethod -eq 'print-window') { throw 'PrintWindow failed for the requested desktop window' }
  }

  if ($scope -eq 'active-window') {
    $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $right = $x + $width
    $bottom = $y + $height
    if ($x -lt $virtual.Left -or $y -lt $virtual.Top -or $right -gt $virtual.Right -or $bottom -gt $virtual.Bottom) {
      throw "target window is not fully inside the virtual screen; refusing a partial geometry-mismatched screenshot"
    }
  }

  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($width, $height)))
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return [ordered]@{ ok=$true; path=$path; scope=$scope; captureMethod='screen'; window=$windowRecord; x=[int]$x; y=[int]$y; width=[int]$width; height=[int]$height }
}
function Resolve-AppLaunchSpec($request) {
  $file = [string](Get-Prop $request 'file' '')
  if (-not [string]::IsNullOrWhiteSpace($file)) {
    return [ordered]@{ mode='file'; file=$file; resolvedName=$file }
  }

  $app = [string](Get-Prop $request 'app' '')
  if ([string]::IsNullOrWhiteSpace($app)) { throw 'launch-app requires file or app' }

  $commandNames = @($app)
  if (-not $app.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) {
    $commandNames += "$app.exe"
  }
  foreach ($name in $commandNames) {
    $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
      $path = [string]$command.Source
      if ([string]::IsNullOrWhiteSpace($path)) { $path = [string]$command.Path }
      if (-not [string]::IsNullOrWhiteSpace($path)) {
        return [ordered]@{ mode='file'; file=$path; resolvedName=[string]$command.Name }
      }
    }
  }

  foreach ($name in $commandNames) {
    foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths')) {
      $key = Join-Path $root $name
      try {
        $item = Get-Item -LiteralPath $key -ErrorAction Stop
        $path = [string]$item.GetValue('')
        if (-not [string]::IsNullOrWhiteSpace($path)) {
          return [ordered]@{ mode='file'; file=$path; resolvedName=$name }
        }
      } catch {}
    }
  }

  $shortcutRoots = @(
    [Environment]::GetFolderPath('StartMenu'),
    [Environment]::GetFolderPath('CommonStartMenu')
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
  $shortcuts = @()
  foreach ($root in $shortcutRoots) {
    $programs = Join-Path ([string]$root) 'Programs'
    if (-not (Test-Path -LiteralPath $programs)) { continue }
    $shortcuts += @(Get-ChildItem -LiteralPath $programs -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue)
  }
  $shortcutExact = @($shortcuts | Where-Object {
    ([string]$_.BaseName).Equals($app, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($shortcutExact.Count -gt 0) {
    $match = $shortcutExact[0]
    return [ordered]@{ mode='shortcut'; file=[string]$match.FullName; resolvedName=[string]$match.BaseName }
  }
  $shortcutMatches = @($shortcuts | Where-Object {
    ([string]$_.BaseName).IndexOf($app, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  if ($shortcutMatches.Count -eq 1) {
    $match = $shortcutMatches[0]
    return [ordered]@{ mode='shortcut'; file=[string]$match.FullName; resolvedName=[string]$match.BaseName }
  }
  if ($shortcutMatches.Count -gt 1) {
    $sample = ($shortcutMatches | Select-Object -First 8 | ForEach-Object { [string]$_.BaseName }) -join ' | '
    throw "launch-app app query is ambiguous ($($shortcutMatches.Count) Start Menu shortcuts): $sample"
  }

  $getStartApps = Get-Command -Name Get-StartApps -ErrorAction SilentlyContinue
  if ($null -ne $getStartApps) {
    $apps = @(Get-StartApps | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.AppID) })
    $exact = @($apps | Where-Object {
      $nameText = [string]$_.Name
      $appIdText = [string]$_.AppID
      return $nameText.Equals($app, [StringComparison]::OrdinalIgnoreCase) -or $appIdText.Equals($app, [StringComparison]::OrdinalIgnoreCase)
    })
    $matches = if ($exact.Count -gt 0) { $exact } else {
      @($apps | Where-Object {
        $nameText = [string]$_.Name
        $appIdText = [string]$_.AppID
        return $nameText.IndexOf($app, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $appIdText.IndexOf($app, [StringComparison]::OrdinalIgnoreCase) -ge 0
      })
    }
    if ($matches.Count -eq 1) {
      return [ordered]@{
        mode='shell-app'
        file='explorer.exe'
        appId=[string]$matches[0].AppID
        resolvedName=[string]$matches[0].Name
      }
    }
    if ($matches.Count -gt 1) {
      $sample = ($matches | Select-Object -First 8 | ForEach-Object { "$($_.Name) [$($_.AppID)]" }) -join ' | '
      throw "launch-app app query is ambiguous ($($matches.Count) matches): $sample"
    }
  }

  throw "installed desktop app not found for '$app'; call desktop_list_windows for running apps or provide desktop_launch_app file=<executable path>"
}

$request = Decode-Payload $Payload
try {
  $result = switch ($Action) {
    'list-windows' {
      [ordered]@{ ok=$true; windows=@(Get-Windows) }
    }
    'resolve-app' {
      $spec = Resolve-AppLaunchSpec $request
      [ordered]@{ ok=$true; spec=$spec }
    }
    'launch-app' {
      $requestedFile = [string](Get-Prop $request 'file' '')
      $requestedApp = [string](Get-Prop $request 'app' '')
      if ([string]::IsNullOrWhiteSpace($requestedFile) -and -not [string]::IsNullOrWhiteSpace($requestedApp)) {
        $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
          $_.MainWindowHandle -ne 0 -and (
            ([string]$_.MainWindowTitle).IndexOf($requestedApp, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            ([string]$_.ProcessName).IndexOf($requestedApp, [StringComparison]::OrdinalIgnoreCase) -ge 0
          )
        })
        if ($running.Count -eq 1) {
          Activate-Window $running[0]
          [ordered]@{ ok=$true; mode='existing-window'; processId=[int]$running[0].Id; resolvedName=[string]$running[0].MainWindowTitle; window=(Window-Record $running[0]) }
          break
        }
      }
      $spec = Resolve-AppLaunchSpec $request
      $argumentList = @(Get-Prop $request 'arguments' @())
      $workingDirectory = [string](Get-Prop $request 'workingDirectory' '')
      if ($spec.mode -eq 'shell-app') {
        if ($argumentList.Count -gt 0 -or -not [string]::IsNullOrWhiteSpace($workingDirectory)) {
          throw 'launch-app app=<friendly name> does not support arguments/workingDirectory; provide file=<executable path> for those options'
        }
        $shellTarget = "shell:AppsFolder\$($spec.appId)"
        Start-Process -FilePath $spec.file -ArgumentList @($shellTarget) | Out-Null
        [ordered]@{ ok=$true; mode=$spec.mode; appId=$spec.appId; resolvedName=$spec.resolvedName }
      } elseif ($spec.mode -eq 'shortcut') {
        if ($argumentList.Count -gt 0 -or -not [string]::IsNullOrWhiteSpace($workingDirectory)) {
          throw 'launch-app app=<friendly name> does not support arguments/workingDirectory; provide file=<executable path> for those options'
        }
        Start-Process -FilePath $spec.file | Out-Null
        [ordered]@{ ok=$true; mode=$spec.mode; file=$spec.file; resolvedName=$spec.resolvedName }
      } else {
        $parameters = @{ FilePath=$spec.file; PassThru=$true }
        if ($argumentList.Count -gt 0) { $parameters.ArgumentList = $argumentList }
        if (-not [string]::IsNullOrWhiteSpace($workingDirectory)) { $parameters.WorkingDirectory = $workingDirectory }
        $p = Start-Process @parameters
        [ordered]@{ ok=$true; mode=$spec.mode; processId=[int]$p.Id; file=$spec.file; resolvedName=$spec.resolvedName }
      }
    }
    'open-path' {
      $path = [string](Get-Prop $request 'path' '')
      if ([string]::IsNullOrWhiteSpace($path)) { throw 'open-path requires path' }
      Start-Process -FilePath $path | Out-Null
      [ordered]@{ ok=$true; path=$path }
    }
    'activate-window' {
      $p = Resolve-Window $request $false
      Activate-Window $p
      [ordered]@{ ok=$true; window=(Window-Record $p) }
    }
    'snapshot' {
      Get-Snapshot $request
    }
    'click-target' {
      $process = Resolve-Window $request $true
      Activate-Window $process
      $target = Find-TargetElement $request
      $method = Invoke-Target $target
      Start-Sleep -Milliseconds 100
      [ordered]@{ ok=$true; method=$method; target=$target.Record; window=(Window-Record $process) }
    }
    'click-coordinates' {
      $x = [int](Get-Prop $request 'x' 0); $y = [int](Get-Prop $request 'y' 0)
      $buttonName = [string](Get-Prop $request 'button' 'left')
      Click-Point $x $y ($(if ($buttonName -ieq 'right') { 1 } else { 0 }))
      [ordered]@{ ok=$true; x=$x; y=$y; button=$buttonName }
    }
    'click-visual-point' {
      $process = Resolve-Window $request $true
      Activate-Window $process
      $xRatio = [double](Get-Prop $request 'xRatio' -1)
      $yRatio = [double](Get-Prop $request 'yRatio' -1)
      if ($xRatio -lt 0 -or $xRatio -gt 1 -or $yRatio -lt 0 -or $yRatio -gt 1) {
        throw 'click-visual-point requires xRatio/yRatio between 0 and 1'
      }
      $allowWindowChrome = [bool](Get-Prop $request 'allowWindowChrome' $false)
      if (-not $allowWindowChrome -and $xRatio -ge 0.90 -and $yRatio -le 0.08) {
        throw 'click-visual-point rejected the top-right window-control zone; use desktop_close_window for closing windows'
      }

      $frameHwnd = [int64](Get-Prop $request 'frameHwnd' 0)
      $frameX = [int](Get-Prop $request 'frameX' 0)
      $frameY = [int](Get-Prop $request 'frameY' 0)
      $frameWidth = [int](Get-Prop $request 'frameWidth' 0)
      $frameHeight = [int](Get-Prop $request 'frameHeight' 0)
      if ($frameHwnd -eq 0 -or $frameWidth -le 0 -or $frameHeight -le 0) {
        throw 'click-visual-point requires a bound visual frame from desktop_screenshot'
      }

      $record = Window-Record $process
      if ([int64]$record.hwnd -ne $frameHwnd) {
        throw 'visual frame is stale: the target HWND changed; take a new desktop_screenshot'
      }
      $rect = $record.rect
      $tolerance = 2
      if ([Math]::Abs([int]$rect.x - $frameX) -gt $tolerance -or
          [Math]::Abs([int]$rect.y - $frameY) -gt $tolerance -or
          [Math]::Abs([int]$rect.width - $frameWidth) -gt $tolerance -or
          [Math]::Abs([int]$rect.height - $frameHeight) -gt $tolerance) {
        throw 'visual frame is stale: window bounds changed after screenshot; take a new desktop_screenshot'
      }

      $x = [int][Math]::Round($frameX + (($frameWidth - 1) * $xRatio))
      $y = [int][Math]::Round($frameY + (($frameHeight - 1) * $yRatio))
      $buttonName = [string](Get-Prop $request 'button' 'left')
      Click-Point $x $y ($(if ($buttonName -ieq 'right') { 1 } else { 0 }))
      [ordered]@{ ok=$true; method='bound-window-visual-point'; x=$x; y=$y; xRatio=$xRatio; yRatio=$yRatio; button=$buttonName; frameHwnd=$frameHwnd; frameRect=[ordered]@{x=$frameX;y=$frameY;width=$frameWidth;height=$frameHeight}; window=$record }
    }
    'drag' {
      $fromX=[int](Get-Prop $request 'fromX' 0); $fromY=[int](Get-Prop $request 'fromY' 0)
      $toX=[int](Get-Prop $request 'toX' 0); $toY=[int](Get-Prop $request 'toY' 0)
      $durationMs=[int](Get-Prop $request 'durationMs' 350)
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($fromX,$fromY)
      [PatrolDesktop.Native]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
      $steps=[Math]::Max(2,[Math]::Min(30,[Math]::Ceiling($durationMs/30)))
      for($i=1;$i -le $steps;$i++){
        $x=[int]($fromX+(($toX-$fromX)*$i/$steps)); $y=[int]($fromY+(($toY-$fromY)*$i/$steps))
        [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x,$y)
        Start-Sleep -Milliseconds ([Math]::Max(1,[int]($durationMs/$steps)))
      }
      [PatrolDesktop.Native]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
      [ordered]@{ok=$true;fromX=$fromX;fromY=$fromY;toX=$toX;toY=$toY}
    }
    'type-text' {
      $window = Activate-RequestedWindow $request
      $text = [string](Get-Prop $request 'text' '')
      $clear = [bool](Get-Prop $request 'clear' $false)
      if ($clear) { [System.Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 40 }
      [System.Windows.Forms.Clipboard]::SetText($text)
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      [ordered]@{ ok=$true; chars=$text.Length; window=$window }
    }
    'type-target' {
      $text = [string](Get-Prop $request 'text' '')
      $process = Resolve-Window $request $true
      Activate-Window $process
      $target = Find-TargetElement $request
      $focusMethod = Focus-Target $target
      $clear = [bool](Get-Prop $request 'clear' $false)
      if ($clear) { [System.Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 40 }
      [System.Windows.Forms.Clipboard]::SetText($text)
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      Start-Sleep -Milliseconds 100
      [ordered]@{
        ok=$true
        chars=$text.Length
        focusMethod=$focusMethod
        target=(Element-Record $target.Element)
        window=(Window-Record $process)
      }
    }

    'paste-target' {
      $process = Resolve-Window $request $true
      Activate-Window $process
      $target = Find-TargetElement $request
      $focusMethod = Focus-Target $target
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      Start-Sleep -Milliseconds 100
      [ordered]@{
        ok=$true
        focusMethod=$focusMethod
        target=(Element-Record $target.Element)
        window=(Window-Record $process)
      }
    }
    'press-target' {
      $key=[string](Get-Prop $request 'key' '')
      if ([string]::IsNullOrWhiteSpace($key)) { throw 'press-target requires key' }
      $process = Resolve-Window $request $true
      Activate-Window $process
      $target = Find-TargetElement $request
      $focusMethod = Focus-Target $target
      Send-Key $key
      Start-Sleep -Milliseconds 100
      [ordered]@{
        ok=$true
        key=$key
        focusMethod=$focusMethod
        target=(Element-Record $target.Element)
        window=(Window-Record $process)
      }
    }

    'hotkey' {
      $window = Activate-RequestedWindow $request
      $combo=[string](Get-Prop $request 'combo' '')
      if ([string]::IsNullOrWhiteSpace($combo)) { throw 'hotkey requires combo' }
      Send-Hotkey $combo
      [ordered]@{ok=$true;combo=$combo;window=$window}
    }
    'press' {
      $window = Activate-RequestedWindow $request
      $key=[string](Get-Prop $request 'key' '')
      if ([string]::IsNullOrWhiteSpace($key)) { throw 'press requires key' }
      Send-Key $key
      [ordered]@{ok=$true;key=$key;window=$window}
    }
    'wait' {
      $milliseconds=[int](Get-Prop $request 'milliseconds' 500)
      if($milliseconds -lt 0 -or $milliseconds -gt 600000){throw 'wait milliseconds must be between 0 and 600000'}
      Start-Sleep -Milliseconds $milliseconds
      [ordered]@{ok=$true;milliseconds=$milliseconds}
    }
    'annotate-visual-guide' {
      $sourcePath = [string](Get-Prop $request 'sourcePath' '')
      $path = [string](Get-Prop $request 'path' '')
      if ([string]::IsNullOrWhiteSpace($sourcePath) -or [string]::IsNullOrWhiteSpace($path)) {
        throw 'annotate-visual-guide requires sourcePath and path'
      }
      $markXRatio = Get-Prop $request 'markXRatio' $null
      $markYRatio = Get-Prop $request 'markYRatio' $null
      Write-VisualGuideImage $sourcePath $path $markXRatio $markYRatio
    }
    'prepare-model-vision' {
      $sourcePath = [string](Get-Prop $request 'sourcePath' '')
      $path = [string](Get-Prop $request 'path' '')
      if ([string]::IsNullOrWhiteSpace($sourcePath) -or [string]::IsNullOrWhiteSpace($path)) {
        throw 'prepare-model-vision requires sourcePath and path'
      }
      Write-ModelVisionImage $sourcePath $path ([int](Get-Prop $request 'maxWidth' 896)) ([int](Get-Prop $request 'maxHeight' 896)) ([int](Get-Prop $request 'jpegQuality' 68)) ([double](Get-Prop $request 'cropXRatio' 0)) ([double](Get-Prop $request 'cropYRatio' 0)) ([double](Get-Prop $request 'cropWidthRatio' 1)) ([double](Get-Prop $request 'cropHeightRatio' 1)) ([bool](Get-Prop $request 'upscale' $false))
    }
    'build-visual-action-map' {
      $sourcePath = [string](Get-Prop $request 'sourcePath' '')
      $path = [string](Get-Prop $request 'path' '')
      if ([string]::IsNullOrWhiteSpace($sourcePath) -or [string]::IsNullOrWhiteSpace($path)) {
        throw 'build-visual-action-map requires sourcePath and path'
      }
      $result = [PatrolDesktopVision.Engine]::BuildActionMap(
        $sourcePath,
        $path,
        [double](Get-Prop $request 'cropXRatio' 0),
        [double](Get-Prop $request 'cropYRatio' 0),
        [double](Get-Prop $request 'cropWidthRatio' 1),
        [double](Get-Prop $request 'cropHeightRatio' 1),
        [int](Get-Prop $request 'maxCandidates' 18)
      )
      [ordered]@{
        ok=$true
        path=[string]$result.Path
        sourceWidth=[int]$result.SourceWidth
        sourceHeight=[int]$result.SourceHeight
        crop=[ordered]@{
          x=[int]$result.CropX
          y=[int]$result.CropY
          width=[int]$result.CropWidth
          height=[int]$result.CropHeight
        }
        mapWidth=[int]$result.MapWidth
        mapHeight=[int]$result.MapHeight
        candidates=@($result.Candidates)
      }
    }
    'match-visual-template' {
      $sourcePath = [string](Get-Prop $request 'sourcePath' '')
      $templatePath = [string](Get-Prop $request 'templatePath' '')
      if ([string]::IsNullOrWhiteSpace($sourcePath) -or [string]::IsNullOrWhiteSpace($templatePath)) {
        throw 'match-visual-template requires sourcePath and templatePath'
      }
      $match = [PatrolDesktopVision.Engine]::MatchTemplate(
        $sourcePath,
        $templatePath,
        [double](Get-Prop $request 'expectedXRatio' 0.5),
        [double](Get-Prop $request 'expectedYRatio' 0.5),
        [double](Get-Prop $request 'searchWidthRatio' 0.20),
        [double](Get-Prop $request 'searchHeightRatio' 0.20)
      )
      [ordered]@{
        ok=$true
        matched=[bool]$match.Matched
        score=[double]$match.Score
        left=[int]$match.Left
        top=[int]$match.Top
        width=[int]$match.Width
        height=[int]$match.Height
        centerXRatio=[double]$match.CenterXRatio
        centerYRatio=[double]$match.CenterYRatio
        scale=[double]$match.Scale
      }
    }
    'screenshot' {
      Capture-Screenshot $request
    }
    'set-clipboard-text' {
      $text=[string](Get-Prop $request 'text' '')
      [System.Windows.Forms.Clipboard]::SetText($text)
      [ordered]@{ok=$true;chars=$text.Length}
    }
    'set-clipboard-files' {
      $paths=@(Get-Prop $request 'paths' @())
      if($paths.Count -eq 0){throw 'set-clipboard-files requires at least one path'}
      $collection=New-Object System.Collections.Specialized.StringCollection
      foreach($path in $paths){
        $resolved=[IO.Path]::GetFullPath([string]$path)
        if(-not (Test-Path -LiteralPath $resolved)){throw "clipboard file does not exist: $resolved"}
        [void]$collection.Add($resolved)
      }
      [System.Windows.Forms.Clipboard]::SetFileDropList($collection)
      [ordered]@{ok=$true;count=$collection.Count;paths=@($collection)}
    }
    'paste' {
      $window = Activate-RequestedWindow $request
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      [ordered]@{ok=$true;window=$window}
    }
    'close-window' {
      $p=Resolve-Window $request $false
      [void][PatrolDesktop.Native]::PostMessage([IntPtr]$p.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)
      [ordered]@{ok=$true;window=(Window-Record $p)}
    }
    'delete-path' {
      $path=[string](Get-Prop $request 'path' '')
      if([string]::IsNullOrWhiteSpace($path)){throw 'delete-path requires path'}
      $resolved=[IO.Path]::GetFullPath($path)
      if(-not (Test-Path -LiteralPath $resolved)){throw "path does not exist: $resolved"}
      $recursive=[bool](Get-Prop $request 'recursive' $false)
      Remove-Item -LiteralPath $resolved -Force -Recurse:$recursive
      [ordered]@{ok=$true;path=$resolved;recursive=$recursive}
    }
    default { throw "unsupported desktop action '$Action'" }
  }

  $result | ConvertTo-Json -Depth 8 -Compress
  exit 0
} catch {
  [ordered]@{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Depth 4 -Compress
  exit 1
}
