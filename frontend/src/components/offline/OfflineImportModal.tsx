/**
 * 离线包导入弹窗：粘贴 / 上传外勤带回的离线包 JSON，按稳定编号合并。
 * 检测到未完成的导入草稿时提示「接着处理」，保住进度不丢。
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Space, Tag, Typography, Upload, message } from 'antd';
import { InboxOutlined, RedoOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { useOfflineStore } from '@/stores/offlineStore';
import { packageMeta, parseOfflinePackage, type OfflinePackage, type OfflinePackageMeta } from '@/types/offline';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported?: () => void;
}

export default function OfflineImportModal({ open, onClose, onImported }: Props) {
  const importing = useOfflineStore((state) => state.importing);
  const resumableDraftId = useOfflineStore((state) => state.resumableDraftId);
  const importPackage = useOfflineStore((state) => state.importPackage);
  const resumeDraft = useOfflineStore((state) => state.resumeDraft);
  const discardDraft = useOfflineStore((state) => state.discardDraft);
  const refreshResumable = useOfflineStore((state) => state.refreshResumable);

  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<OfflinePackageMeta | null>(null);
  const [parsed, setParsed] = useState<OfflinePackage | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setMeta(null);
      setParsed(null);
      void refreshResumable();
    }
  }, [open, refreshResumable]);

  function handleParse(): void {
    setError(null);
    try {
      const pkg = parseOfflinePackage(text);
      setParsed(pkg);
      setMeta(packageMeta(pkg));
    } catch (parseError) {
      const msg = parseError instanceof Error ? parseError.message : '解析失败';
      setError(msg);
      setMeta(null);
      setParsed(null);
    }
  }

  async function handleImport(): Promise<void> {
    if (!parsed) return;
    setError(null);
    try {
      const summary = await importPackage(parsed);
      message.success(
        `合并完成：新增 ${summary.added} · 候补 ${summary.waitlisted} · 待定 ${summary.pending} · 跳过 ${summary.skipped}`
      );
      setText('');
      setMeta(null);
      setParsed(null);
      onImported?.();
      onClose();
    } catch (importError) {
      const msg = importError instanceof Error ? importError.message : '导入失败';
      setError(msg);
      message.error(`导入失败：${msg}`);
    }
  }

  async function handleResume(): Promise<void> {
    if (!resumableDraftId) return;
    setError(null);
    try {
      const summary = await resumeDraft(resumableDraftId);
      message.success(
        `已接着处理：新增 ${summary.added} · 候补 ${summary.waitlisted} · 待定 ${summary.pending} · 跳过 ${summary.skipped}`
      );
      onImported?.();
      onClose();
    } catch (resumeError) {
      const msg = resumeError instanceof Error ? resumeError.message : '续跑失败';
      setError(msg);
    }
  }

  async function handleDiscard(): Promise<void> {
    if (!resumableDraftId) return;
    await discardDraft(resumableDraftId);
    message.success('草稿已丢弃');
  }

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    showUploadList: false,
    beforeUpload: (file) => {
      const reader = new FileReader();
      reader.onload = () => {
        setText(String(reader.result ?? ''));
        setError(null);
        setMeta(null);
        setParsed(null);
      };
      reader.readAsText(file);
      return false;
    }
  };

  return (
    <Modal
      open={open}
      title="导入离线包（按稳定编号合并）"
      onCancel={onClose}
      width={640}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button onClick={handleParse} disabled={text.trim().length === 0}>
            解析
          </Button>
          <Button type="primary" onClick={handleImport} loading={importing} disabled={!parsed}>
            确认合并
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {resumableDraftId ? (
          <Alert
            type="warning"
            showIcon
            message="有未完成的导入草稿"
            description="上次导入中断，草稿已保住。可接着处理，已追加 / 已待定的场次不会重复。"
            action={
              <Space>
                <Button size="small" type="primary" icon={<RedoOutlined />} onClick={handleResume} loading={importing}>
                  接着处理
                </Button>
                <Button size="small" onClick={handleDiscard}>
                  丢弃草稿
                </Button>
              </Space>
            }
          />
        ) : null}

        {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} /> : null}

        <Upload {...uploadProps}>
          <Button icon={<InboxOutlined />}>选择离线包 JSON 文件</Button>
        </Upload>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          也可直接粘贴外勤带回的 JSON 内容：
        </Typography.Text>
        <Input.TextArea
          rows={8}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setMeta(null);
            setParsed(null);
          }}
          placeholder='{"packageNo":"PKG-20240312","sessions":[...],...}'
        />

        {meta ? (
          <Alert
            type="success"
            showIcon
            message={`已解析离线包 ${meta.packageNo}`}
            description={
              <Space size={8} wrap>
                {meta.source ? <Tag color="blue">来源：{meta.source}</Tag> : null}
                <Tag>项目 {meta.projectCount}</Tag>
                <Tag>曲目 {meta.songCount}</Tag>
                <Tag>场次 {meta.sessionCount}</Tag>
                <Tag>Take {meta.takeCount}</Tag>
              </Space>
            }
          />
        ) : null}
      </Space>
    </Modal>
  );
}
