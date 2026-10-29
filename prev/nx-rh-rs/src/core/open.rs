// 交给操作系统的两个动作：打开浏览器、在文件管理器里打开目录。
// 刻意不报错——打不开就算了，调用方已经打印了地址。

pub fn open_browser(url: &str) {
    open_target(url);
}

pub fn open_path(dir: &str) {
    open_target(dir);
}

fn open_target(target: &str) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", target])
            .creation_flags(0x08000008) // CREATE_NO_WINDOW | DETACHED_PROCESS
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(target).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(target).spawn();
    }
}
