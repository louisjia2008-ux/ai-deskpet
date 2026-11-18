import SwiftUI
import AppKit
import AICore

// P17 / SP-02 — Data & sync page. Migrated to DS components + tokens (no raw spacing,
// no `Color.secondary.opacity(0.06)`, no cornerRadius literals). Per-category sync opt-in
// + local encrypted backup/restore.
struct DataView: View {
    @ObservedObject var prefs: PreferencesModel
    let backup: BackupService

    @State private var password = ""
    @State private var status: BackupStatus?
    @State private var pendingRestore: (url: URL, contents: BackupService.Contents)?

    var body: some View {
        // Hosted inside AppShellView's scroll; no own ScrollView (avoids nested scrolling).
        VStack(alignment: .leading, spacing: DSSpacing.l) {
            syncCard
            backupCard
            if let p = pendingRestore { restorePreview(p) }
            if let status { statusRow(status) }
        }
    }

    private var syncCard: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.m) {
                SectionHeader("iCloud 同步", subtitle: "私密会话、截图与语音缓存永不上传")
                Toggle("启用 iCloud 同步", isOn: Binding(
                    get: { prefs.prefs.sync.iCloudEnabled }, set: { prefs.setICloud($0) }))
                Text("默认同步：设置、任务、专注统计、关系与解锁。聊天与记忆正文需逐类开启。")
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textSecondary)
                Divider().overlay(DSColor.border)
                ForEach(SyncCategory.allCases, id: \.self) { c in
                    Toggle(c.label + (c.syncsByDefault ? "" : "（默认仅本地）"), isOn: Binding(
                        get: { prefs.prefs.sync.enabled.contains(c) },
                        set: { prefs.setCategory(c, $0) }))
                        .disabled(!prefs.prefs.sync.iCloudEnabled)
                }
                InlineNotice(kind: .info,
                             text: "iCloud 同步将在正式发布后启用；当前设置会保留在本地。")
            }
        }
    }

    private var backupCard: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.m) {
                SectionHeader("加密备份")
                SecureField("备份密码（不会写入备份）", text: $password)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 280)
                HStack(spacing: DSSpacing.s) {
                    Button("导出加密备份…", action: exportBackup)
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(password.isEmpty)
                    Button("从备份恢复…", action: pickRestore)
                        .buttonStyle(SecondaryButtonStyle())
                        .disabled(password.isEmpty)
                }
            }
        }
    }

    private func restorePreview(_ p: (url: URL, contents: BackupService.Contents)) -> some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                SectionHeader("将恢复（请确认内容清单）")
                Text("备份时间：\(p.contents.createdAt.formatted())")
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textSecondary)
                ForEach(p.contents.entries.sorted(by: { $0.key < $1.key }), id: \.key) { k, v in
                    Text("• \(k) — \(v) 字节")
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.textSecondary)
                }
                HStack(spacing: DSSpacing.s) {
                    Button("完整恢复") {
                        doRestore(p.url,
                                  categories: nil,
                                  expectedDigest: p.contents.sourceDigest)
                    }
                        .buttonStyle(PrimaryButtonStyle())
                    Button("取消") { pendingRestore = nil }
                        .buttonStyle(SecondaryButtonStyle())
                }
            }
        }
    }

    private func statusRow(_ s: BackupStatus) -> some View {
        InlineNotice(kind: s.isError ? .error : .info, text: s.message)
    }

    // MARK: Actions

    private func exportBackup() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.prompt = "选择导出位置"
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        do {
            let url = try backup.export(password: password, to: folder)
            status = .init(message: "已导出：\(url.lastPathComponent)", isError: false)
        } catch {
            status = .init(message: "导出失败：\(error.localizedDescription)", isError: true)
        }
    }

    private func pickRestore() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true; panel.canChooseDirectories = false
        panel.allowedContentTypes = []; panel.prompt = "选择备份文件"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let contents = try backup.inspect(at: url, password: password)
            pendingRestore = (url, contents)
            status = nil
        } catch {
            status = .init(message: "无法读取备份：\(error.localizedDescription)", isError: true)
        }
    }

    private func doRestore(_ url: URL,
                           categories: Set<SyncCategory>?,
                           expectedDigest: Data) {
        do {
            try backup.restore(from: url,
                               password: password,
                               categories: categories,
                               expectedDigest: expectedDigest)
            status = .init(message: "恢复完成。请重启应用以加载新数据。", isError: false)
            pendingRestore = nil
        } catch EncryptedBackup.BackupError.badPassword {
            status = .init(message: "密码错误，恢复已取消（原数据保留）。", isError: true)
        } catch BackupService.RestoreError.incompatibleNewer(let v) {
            status = .init(message: "备份来自更新的版本（v\(v)），已拒绝以避免损坏（原数据保留）。",
                           isError: true)
        } catch {
            status = .init(message: "恢复失败：\(error.localizedDescription)", isError: true)
        }
    }
}

private struct BackupStatus: Equatable {
    let message: String
    let isError: Bool
}
