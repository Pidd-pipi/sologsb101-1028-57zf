/**
 * 离线包导入弹窗：粘贴 / 选择离线包 JSON，按稳定编号合并。
 * 整包不覆盖当天安排；中断后凭编号续写。制作人在这里看不到「覆盖」按钮。
 */
import { useState } from 'react';
import { Alert, Button, Modal, Space, Tabs, Upload, message } from 'antd';
import { FileTextOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { useImportStore } from '@/stores/importStore';
import type { MergeResult } from '@/types/merge';

interface ImportPackageModalProps {
  open: boolean;
  onClose: () => void;
  /** 合并完成：由页面决定是否打开待定裁决面板 */
  onMerged: (result: MergeResult) => void;
}

export default function ImportPackageModal({ open, onClose, onMerged }: ImportPackageModalProps) {
  const mergeText = useImportStore((state) => state.mergeText);
  const busy = useImportStore((state) => state.busy);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    showUploadList: false,
    beforeUpload: async (file) => {
      try {
        const content = await file.text();
        setText(content);
        setError(null);
        message.success(`已读取离线包：${file.name}`);
      } catch {
        setError('读取文件失败，请改用粘贴文本方式');
      }
      return false;
    }
  };

  async function handleMerge(): Promise<void> {
    if (text.trim().length === 0) {
      setError('请先选择或粘贴外勤离线包');
      return;
    }
    setError(null);
    try {
      const result = await mergeText(text);
      setText('');
      message.success(
        result.resumed
          ? `已续写编号 ${result.packageNo} 的中断导入`
          : `离线包 ${result.packageNo} 已按稳定编号合并`
      );
      onMerged(result);
    } catch (mergeError) {
      const detail = mergeError instanceof Error ? mergeError.message : '合并失败';
      setError(detail);
    }
  }

  return (
    <Modal
      open={open}
      title="导入外勤离线包（按稳定编号合并）"
      onCancel={onClose}
      onOk={() => void handleMerge()}
      okText="按编号合并"
      cancelText="关闭"
      width={680}
      confirmLoading={busy}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="合并规则"
          description="不同曲目 / 新增场次与新增 Take 直接接上；同一场次的棚号、时段、乐手有两套值时先列待定，您选定前不写正式排期；容量不足的场次按提交顺序候补，不会挤掉已确认场次。"
        />
        {error ? <Alert type="error" showIcon message={error} /> : null}
        <Tabs
          defaultActiveKey="file"
          items={[
            {
              key: 'file',
              label: '选择文件',
              children: (
                <Upload.Dragger {...uploadProps}>
                  <p className="ant-upload-drag-icon">
                    <FileTextOutlined />
                  </p>
                  <p className="ant-upload-text">点击或拖入外勤带回的 .json 离线包</p>
                  <p className="ant-upload-hint">按包内稳定编号合并，重复导入同一编号不会产生重复数据</p>
                </Upload.Dragger>
              )
            },
            {
              key: 'text',
              label: '粘贴文本',
              children: (
                <textarea
                  rows={8}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="粘贴离线包 JSON 内容"
                  style={{
                    width: '100%',
                    padding: 10,
                    borderRadius: 8,
                    border: '1px solid #d9e2ec',
                    fontFamily: 'monospace',
                    fontSize: 12
                  }}
                />
              )
            }
          ]}
        />
        {text.trim().length > 0 ? (
          <Space>
            <Button size="small" type="link" onClick={() => setText('')}>
              清空内容
            </Button>
          </Space>
        ) : null}
      </Space>
    </Modal>
  );
}
