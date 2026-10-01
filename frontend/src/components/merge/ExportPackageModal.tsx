/**
 * 导出外勤离线包：填写稳定编号与外勤来源，导出后可被其它设备按同编号合并。
 */
import { useEffect, useState } from 'react';
import { Alert, Form, Input, Modal, message } from 'antd';
import { buildOfflinePackage, defaultPackageNo } from '@/utils/offlinePackage';
import { downloadJson } from '@/utils/export';

interface ExportPackageModalProps {
  open: boolean;
  onClose: () => void;
}

interface ExportForm {
  packageNo: string;
  origin: string;
}

export default function ExportPackageModal({ open, onClose }: ExportPackageModalProps) {
  const [form] = Form.useForm<ExportForm>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ packageNo: defaultPackageNo(), origin: '' });
    }
  }, [open, form]);

  async function handleExport(): Promise<void> {
    const values = await form.validateFields();
    setBusy(true);
    try {
      const pkg = await buildOfflinePackage(values.packageNo, values.origin);
      downloadJson(`离线包-${pkg.packageNo}.json`, JSON.stringify(pkg, null, 2));
      message.success(`离线包 ${pkg.packageNo} 已导出`);
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '导出失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="导出外勤离线包"
      onCancel={onClose}
      onOk={() => void handleExport()}
      okText="导出离线包"
      cancelText="取消"
      confirmLoading={busy}
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="同一稳定编号重复导入按合并处理，不会覆盖对端当天安排"
      />
      <Form form={form} layout="vertical">
        <Form.Item
          name="packageNo"
          label="稳定编号"
          rules={[{ required: true, message: '请填写稳定编号' }]}
          extra="建议保持 PKG-日期-时刻 形式；同一批外勤数据沿用同一编号，中断后可凭它续写。"
        >
          <Input placeholder="PKG-20261001-1530" />
        </Form.Item>
        <Form.Item name="origin" label="外勤来源 / 提交人">
          <Input placeholder="如：二号棚外勤组 · 黎川" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
