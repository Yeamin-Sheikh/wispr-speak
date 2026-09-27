/**
 * Wispr Tell Windows paste helper (tell-paste.exe)
 *
 * Adapted from OpenWhispr's windows-fast-paste.c — MIT License,
 * Copyright (c) 2024 OpenWhispr Team. Original notice retained below
 * per the MIT license terms. Wispr Tell branding applied.
 *
 * ---- Original MIT license notice ----
 * MIT License
 * Copyright (c) 2024 OpenWhispr Team
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * ---- End original notice ----
 */


#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

static const char* TERMINAL_CLASSES[] = {
    "ConsoleWindowClass",
    "CASCADIA_HOSTING_WINDOW_CLASS",
    "mintty",
    "VirtualConsoleClass",
    "PuTTY",
    "Alacritty",
    "org.wezfurlong.wezterm",
    "Hyper",
    "TMobaXterm",
    "kitty",
    NULL
};

/* Electron-based terminals share Chrome_WidgetWin_1 as window class,
   so we detect them by executable name instead */
static const char* TERMINAL_EXES[] = {
    "termius.exe",
    "tabby.exe",
    "wave.exe",
    "rio.exe",
    NULL
};

static BOOL IsTerminalClass(const char* className) {
    for (int i = 0; TERMINAL_CLASSES[i] != NULL; i++) {
        if (_stricmp(className, TERMINAL_CLASSES[i]) == 0) {
            return TRUE;
        }
    }
    return FALSE;
}

static BOOL GetExeName(HWND hwnd, char* exeName, DWORD exeNameSize) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) return FALSE;

    HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!hProcess) return FALSE;

    char exePath[MAX_PATH];
    DWORD pathLen = MAX_PATH;
    BOOL ok = QueryFullProcessImageNameA(hProcess, 0, exePath, &pathLen);
    CloseHandle(hProcess);

    if (!ok || pathLen == 0) return FALSE;

    const char* baseName = strrchr(exePath, '\\');
    baseName = baseName ? baseName + 1 : exePath;

    strncpy(exeName, baseName, exeNameSize - 1);
    exeName[exeNameSize - 1] = '\0';
    return TRUE;
}

static BOOL IsTerminalExe(const char* exeName) {
    for (int i = 0; TERMINAL_EXES[i] != NULL; i++) {
        if (_stricmp(exeName, TERMINAL_EXES[i]) == 0) {
            return TRUE;
        }
    }
    return FALSE;
}

static void SetKey(INPUT* input, WORD vk, DWORD flags) {
    input->type = INPUT_KEYBOARD;
    input->ki.wVk = vk;
    input->ki.wScan = (WORD)MapVirtualKeyA(vk, MAPVK_VK_TO_VSC);
    input->ki.dwFlags = flags;
}

/* Modifier keys that may interfere with SendInput if held by the user's
   hotkey.  We check left/right-specific variants since GetAsyncKeyState
   reports physical key state per side. */
static const WORD MODIFIER_VKS[] = {
    VK_LCONTROL, VK_RCONTROL,
    VK_LSHIFT,   VK_RSHIFT,
    VK_LMENU,    VK_RMENU,
    VK_LWIN,     VK_RWIN,
};
#define NUM_MODIFIERS (sizeof(MODIFIER_VKS) / sizeof(MODIFIER_VKS[0]))

/* Release any modifier keys that are currently held down so they don't
   contaminate the paste keystroke.  Returns the count of keys released;
   the caller must pass the same arrays back to RestoreModifiers(). */
static int ReleaseModifiers(INPUT* released, WORD* releasedVKs) {
    int count = 0;
    for (int i = 0; i < (int)NUM_MODIFIERS; i++) {
        if (GetAsyncKeyState(MODIFIER_VKS[i]) & 0x8000) {
            releasedVKs[count] = MODIFIER_VKS[i];
            SetKey(&released[count], MODIFIER_VKS[i], KEYEVENTF_KEYUP);
            count++;
        }
    }
    if (count > 0) {
        SendInput((UINT)count, released, sizeof(INPUT));
    }
    return count;
}

/* Re-press modifier keys that were released by ReleaseModifiers(). */
static void RestoreModifiers(WORD* releasedVKs, int count) {
    if (count == 0) return;
    INPUT restore[NUM_MODIFIERS];
    ZeroMemory(restore, sizeof(restore));
    for (int i = 0; i < count; i++) {
        SetKey(&restore[i], releasedVKs[i], 0);
    }
    SendInput((UINT)count, restore, sizeof(INPUT));
}

static int SendPasteNormal(void) {
    INPUT inputs[4];
    ZeroMemory(inputs, sizeof(inputs));

    SetKey(&inputs[0], VK_LCONTROL, 0);
    SetKey(&inputs[1], 'V', 0);
    SetKey(&inputs[2], 'V', KEYEVENTF_KEYUP);
    SetKey(&inputs[3], VK_LCONTROL, KEYEVENTF_KEYUP);

    UINT sent = SendInput(4, inputs, sizeof(INPUT));
    return (sent == 4) ? 0 : 1;
}

/* Bring a captured target window back to the foreground before pasting.
   SetForegroundWindow alone is blocked by Windows' foreground lock when the
   calling process isn't the current foreground owner, so we attach this
   thread's input queue to both the current foreground thread and the target
   thread first — the standard workaround, and what nircmd's "win activate"
   does internally. Returns TRUE if the target ended up foreground. */
static BOOL RestoreForegroundWindow(HWND target) {
    if (!target || !IsWindow(target)) return FALSE;

    if (GetForegroundWindow() == target) return TRUE;

    if (IsIconic(target)) {
        ShowWindow(target, SW_RESTORE);
    }

    HWND fg = GetForegroundWindow();
    DWORD thisThread = GetCurrentThreadId();
    DWORD targetThread = GetWindowThreadProcessId(target, NULL);
    DWORD fgThread = fg ? GetWindowThreadProcessId(fg, NULL) : 0;

    BOOL attachedTarget = FALSE;
    BOOL attachedFg = FALSE;
    if (targetThread && targetThread != thisThread) {
        attachedTarget = AttachThreadInput(thisThread, targetThread, TRUE);
    }
    if (fgThread && fgThread != thisThread && fgThread != targetThread) {
        attachedFg = AttachThreadInput(thisThread, fgThread, TRUE);
    }

    BringWindowToTop(target);
    BOOL ok = SetForegroundWindow(target);
    SetFocus(target);

    if (attachedFg) AttachThreadInput(thisThread, fgThread, FALSE);
    if (attachedTarget) AttachThreadInput(thisThread, targetThread, FALSE);

    return ok && GetForegroundWindow() == target;
}

static int SendPasteTerminal(void) {
    INPUT inputs[6];
    ZeroMemory(inputs, sizeof(inputs));

    SetKey(&inputs[0], VK_LCONTROL, 0);
    SetKey(&inputs[1], VK_LSHIFT, 0);
    SetKey(&inputs[2], 'V', 0);
    SetKey(&inputs[3], 'V', KEYEVENTF_KEYUP);
    SetKey(&inputs[4], VK_LSHIFT, KEYEVENTF_KEYUP);
    SetKey(&inputs[5], VK_LCONTROL, KEYEVENTF_KEYUP);

    UINT sent = SendInput(6, inputs, sizeof(INPUT));
    return (sent == 6) ? 0 : 1;
}

static int SendCopyNormal(void) {
    INPUT inputs[4];
    ZeroMemory(inputs, sizeof(inputs));

    SetKey(&inputs[0], VK_LCONTROL, 0);
    SetKey(&inputs[1], 'C', 0);
    SetKey(&inputs[2], 'C', KEYEVENTF_KEYUP);
    SetKey(&inputs[3], VK_LCONTROL, KEYEVENTF_KEYUP);

    return (SendInput(4, inputs, sizeof(INPUT)) == 4) ? 0 : 1;
}

static int SendCopyTerminal(void) {
    INPUT inputs[6];
    ZeroMemory(inputs, sizeof(inputs));

    SetKey(&inputs[0], VK_LCONTROL, 0);
    SetKey(&inputs[1], VK_LSHIFT, 0);
    SetKey(&inputs[2], 'C', 0);
    SetKey(&inputs[3], 'C', KEYEVENTF_KEYUP);
    SetKey(&inputs[4], VK_LSHIFT, KEYEVENTF_KEYUP);
    SetKey(&inputs[5], VK_LCONTROL, KEYEVENTF_KEYUP);

    return (SendInput(6, inputs, sizeof(INPUT)) == 6) ? 0 : 1;
}

static void SendUnicodeChar(WCHAR ch) {
    INPUT inputs[2];
    ZeroMemory(inputs, sizeof(inputs));

    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = 0;
    inputs[0].ki.wScan = ch;
    inputs[0].ki.dwFlags = KEYEVENTF_UNICODE;

    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = 0;
    inputs[1].ki.wScan = ch;
    inputs[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;

    SendInput(2, inputs, sizeof(INPUT));
}

static void SendEnterKey(void) {
    INPUT inputs[2];
    ZeroMemory(inputs, sizeof(inputs));
    SetKey(&inputs[0], VK_RETURN, 0);
    SetKey(&inputs[1], VK_RETURN, KEYEVENTF_KEYUP);
    SendInput(2, inputs, sizeof(INPUT));
}

static int StreamTypeFromStdin(void) {
    size_t capacity = 16384;
    size_t totalRead = 0;
    char* utf8Buf = (char*)malloc(capacity);
    if (!utf8Buf) return 1;

    size_t n;
    while ((n = fread(utf8Buf + totalRead, 1, capacity - totalRead - 1, stdin)) > 0) {
        totalRead += n;
        if (totalRead + 1024 >= capacity) {
            capacity *= 2;
            char* resized = (char*)realloc(utf8Buf, capacity);
            if (!resized) {
                free(utf8Buf);
                return 1;
            }
            utf8Buf = resized;
        }
    }
    utf8Buf[totalRead] = '\0';

    if (totalRead == 0) {
        free(utf8Buf);
        return 0;
    }

    int wideLen = MultiByteToWideChar(CP_UTF8, 0, utf8Buf, -1, NULL, 0);
    if (wideLen <= 1) {
        free(utf8Buf);
        return 0;
    }

    WCHAR* wideBuf = (WCHAR*)malloc(wideLen * sizeof(WCHAR));
    if (!wideBuf) {
        free(utf8Buf);
        return 1;
    }
    MultiByteToWideChar(CP_UTF8, 0, utf8Buf, -1, wideBuf, wideLen);
    free(utf8Buf);

    srand((unsigned int)GetTickCount());

    for (int i = 0; i < wideLen - 1; i++) {
        if (GetAsyncKeyState(VK_ESCAPE) & 0x8000) {
            free(wideBuf);
            return 0;
        }

        WCHAR ch = wideBuf[i];
        if (ch == L'\r' && wideBuf[i + 1] == L'\n') {
            continue;
        }

        if (ch == L'\n') {
            SendEnterKey();
        } else {
            SendUnicodeChar(ch);
        }

        int delay = 12 + (rand() % 17);
        if (ch == L'.' || ch == L',' || ch == L'!' || ch == L'?' || ch == L';') {
            delay += 45;
        } else if (ch == L' ') {
            delay += 15;
        }
        Sleep(delay);
    }

    free(wideBuf);
    return 0;
}

int main(int argc, char* argv[]) {
    BOOL detectOnly = FALSE;
    BOOL copyMode = FALSE;
    BOOL capabilitiesOnly = FALSE;
    BOOL getSeqOnly = FALSE;
    BOOL typeStdinMode = FALSE;
    HWND restoreWindow = NULL;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--detect-only") == 0) {
            detectOnly = TRUE;
        } else if (strcmp(argv[i], "--copy") == 0) {
            copyMode = TRUE;
        } else if (strcmp(argv[i], "--capabilities") == 0) {
            capabilitiesOnly = TRUE;
        } else if (strcmp(argv[i], "--get-seq") == 0) {
            getSeqOnly = TRUE;
        } else if (strcmp(argv[i], "--type-stdin") == 0) {
            typeStdinMode = TRUE;
        } else if (strcmp(argv[i], "--restore-window") == 0 && i + 1 < argc) {
            /* Base 16: the handle comes back exactly as --detect-only printed
               it with "TARGET %p" (hex, with or without an 0x prefix). */
            restoreWindow = (HWND)(uintptr_t)strtoull(argv[++i], NULL, 16);
        }
    }

    if (capabilitiesOnly) {
        printf("paste-v1 selection-copy-v1 target-identity-v1 focus-restore-v1 clipboard-seq-v1 type-unicode-v1\n");
        return 0;
    }

    if (getSeqOnly) {
        DWORD seq = GetClipboardSequenceNumber();
        printf("CLIPBOARD_SEQ %lu\n", seq);
        fflush(stdout);
        return 0;
    }

    if (typeStdinMode) {
        if (restoreWindow && GetForegroundWindow() != restoreWindow &&
            RestoreForegroundWindow(restoreWindow)) {
            Sleep(20);
        }

        INPUT releasedInputs[NUM_MODIFIERS];
        WORD releasedVKs[NUM_MODIFIERS];
        ZeroMemory(releasedInputs, sizeof(releasedInputs));
        int releasedCount = ReleaseModifiers(releasedInputs, releasedVKs);

        int res = StreamTypeFromStdin();

        RestoreModifiers(releasedVKs, releasedCount);

        if (res == 0) {
            printf("TYPING_OK\n");
            fflush(stdout);
            return 0;
        } else {
            fprintf(stderr, "ERROR: Stream typing failed\n");
            return 1;
        }
    }

    /* Restore the captured target to the foreground before pasting. If it is
       gone or can't be restored we fall through to whatever is foreground now,
       which is the pre-#859 behavior. The settle sleep only applies when a
       window switch actually happened — in the common case where the target
       never lost the foreground, the paste goes out immediately. */
    if (restoreWindow && GetForegroundWindow() != restoreWindow &&
        RestoreForegroundWindow(restoreWindow)) {
        Sleep(20);
    }

    HWND hwnd = GetForegroundWindow();
    if (!hwnd) {
        fprintf(stderr, "ERROR: No foreground window found\n");
        return 2;
    }

    char className[256];
    int classLen = GetClassNameA(hwnd, className, sizeof(className));
    if (classLen == 0) {
        fprintf(stderr, "ERROR: Could not get window class name (error %lu)\n", GetLastError());
        return 1;
    }

    BOOL isTerminal = IsTerminalClass(className);

    char exeName[MAX_PATH] = {0};
    BOOL gotExeName = GetExeName(hwnd, exeName, sizeof(exeName));

    if (!isTerminal && gotExeName) {
        isTerminal = IsTerminalExe(exeName);
    }

    char windowTitle[512] = {0};
    int titleLen = GetWindowTextA(hwnd, windowTitle, sizeof(windowTitle));
    if (titleLen > 0) {
        for (int j = 0; j < titleLen; j++) {
            if (windowTitle[j] == '\r' || windowTitle[j] == '\n') {
                windowTitle[j] = ' ';
            }
        }
    }

    if (detectOnly) {
        printf("TARGET %p\n", (void*)hwnd);
        printf("WINDOW_CLASS %s\n", className);
        if (gotExeName) {
            printf("EXE_NAME %s\n", exeName);
        }
        printf("WINDOW_TITLE %s\n", windowTitle);
        printf("IS_TERMINAL %s\n", isTerminal ? "true" : "false");
        fflush(stdout);
        return 0;
    }

    Sleep(10);

    /* Release any modifier keys held by the user's hotkey so they don't
       contaminate the paste keystroke (e.g. Ctrl+Win held → Ctrl+Win+V). */
    INPUT releasedInputs[NUM_MODIFIERS];
    WORD  releasedVKs[NUM_MODIFIERS];
    ZeroMemory(releasedInputs, sizeof(releasedInputs));
    int releasedCount = ReleaseModifiers(releasedInputs, releasedVKs);

    int result;
    if (copyMode && isTerminal) {
        result = SendCopyTerminal();
    } else if (copyMode) {
        result = SendCopyNormal();
    } else if (isTerminal) {
        result = SendPasteTerminal();
    } else {
        result = SendPasteNormal();
    }

    RestoreModifiers(releasedVKs, releasedCount);

    if (result != 0) {
        fprintf(stderr, "ERROR: SendInput failed (error %lu)\n", GetLastError());
        return 1;
    }

    Sleep(20);

    if (copyMode) {
        printf("COPY_OK %p %s %s\n", (void*)hwnd, className,
               isTerminal ? "ctrl+shift+c" : "ctrl+c");
    } else {
        printf("PASTE_OK %s %s\n", className, isTerminal ? "ctrl+shift+v" : "ctrl+v");
    }
    fflush(stdout);

    return 0;
}
