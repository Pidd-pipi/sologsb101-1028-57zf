/**
 * 待定裁决面板：离线包与本地对同一场次给出两套棚号 / 时段 / 乐手值时，
 * 由制作人逐条二选一；选定前该场次不写正式排期（Take / 优选暂挂）。
 */
import { useMemo, useState } from 'react';
import { Alert, Button, Descriptions, Empty, Modal, Radio, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useImportStore } from '@/stores/importStore';
import { db, type MergePendingRow, type SongRow } from '@/utils/db';
import type { MergeChoice } from '@/types/merge';

interface MergePendingPanelProps {
  open: boolean;
  onClose: () => void;
}

const FIELD_LABEL: Record<string, string> = {
  roomNo: '棚号',
  period: '时段',
  musicians: '乐手'
};

export default function MergePendingPanel({ open, onClose }: MergePendingPanelProps) {
  const pending = useIdbTable<MergePendingRow>(db.mergePending, (a, b) => a.createdAt - b.createdAt);
  const songs = useIdbTable<SongRow>(db.songs);
  const resolvePending = useImportStore((state) => state.resolvePending);
  const dropPending = useImportStore((state) => state.dropPending);
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const songTitleOf = (songId: string): string => songs.find((item) => item.id === songId)?.title ?? '曲目已删除';

  const columns = useMemo<ColumnsType<MergePendingRow>>(
    () => [
      {
        title: '场次 / 曲目',
        width: 200,
        render: (_, row) => (
          <Space direction="vertical" size={2}>
            <Typography.Text strong>{songTitleOf(row.local.songId || row.incoming.songId)}</Typography.Text>
            <span className="muted">
              {row.packageOrigin} · {row.packageNo}
            </span>
          </Space>
        )
      },
      {
        title: '待定字段',
        width: 150,
        render: (_, row) => (
          <Space wrap>
            {row.fields.map((field) => (
              <Tag key={field} color="orange">
                {FIELD_LABEL[field] ?? field}
              </Tag>
            ))}
          </Space>
        )
      },
      {
        title: '本地排期',
        render: (_, row) => (
          <Descriptions column={1} size="small">
            <Descriptions.Item label="棚号">{row.local.roomNo}</Descriptions.Item>
            <Descriptions.Item label="时段">{row.local.period}</Descriptions.Item>
            <Descriptions.Item label="乐手">{row.local.musicians || '—'}</Descriptions.Item>
          </Descriptions>
        )
      },
      {
        title: '离线包带回',
        render: (_, row) => (
          <Descriptions column={1} size="small">
            <Descriptions.Item label="棚号">
              <Space>
                {row.incoming.roomNo}
                {row.fields.includes('roomNo') ? <Tag color="blue">不同</Tag> : null}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="时段">
              <Space>
                {row.incoming.period}
                {row.fields.includes('period') ? <Tag color="blue">不同</Tag> : null}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="乐手">
              <Space align="start">
                <span>{row.incoming.musicians || '—'}</span>
                {row.fields.includes('musicians') ? <Tag color="blue">不同</Tag> : null}
              </Space>
            </Descriptions.Item>
          </Descriptions>
        )
      },
      {
        title: '暂挂',
        width: 90,
        render: (_, row) => (
          <Space direction="vertical" size={0}>
            <Tag>{row.deferredTakes.length} Take</Tag>
            <Tag>{row.deferredPicks.length} 优选</Tag>
          </Space>
        )
      },
      {
        title: '制作人裁决',
        width: 260,
        render: (_, row) => (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              value={choices[row.id] ?? null}
              onChange={(event) => setChoices((prev) => ({ ...prev, [row.id]: event.target.value as MergeChoice }))}
              options={[
                { label: '采用本地', value: 'local' },
                { label: '采用离线包', value: 'package' }
              ]}
            />
            <Space>
              <Button
                type="primary"
                size="small"
                loading={busyId === row.id}
                disabled={!choices[row.id]}
                onClick={async () => {
                  setBusyId(row.id);
                  try {
                    await resolvePending(row.id, choices[row.id]);
                    message.success('已写入正式排期，容量已重新核算');
                    setChoices((prev) => {
                      const next = { ...prev };
                      delete next[row.id];
                      return next;
                    });
                  } catch (error) {
                    message.error(error instanceof Error ? error.message : '裁决失败');
                  } finally {
                    setBusyId(null);
                  }
                }}
              >
                写入排期
              </Button>
              <Button
                size="small"
                danger
                onClick={async () => {
                  await dropPending(row.id);
                  message.info('已放弃该条离线包场次');
                }}
              >
                放弃
              </Button>
            </Space>
          </Space>
        )
      }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [choices, busyId, songs]
  );

  return (
    <Modal
      open={open}
      title={`待定场次裁决（${pending.length}）`}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭（未裁决项继续保留）</Button>}
      width={1080}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type="warning"
          showIcon
          message="制作人选定前不写正式排期"
          description="离线包与本地对棚号、时段或乐手给出了两套值。请逐条选择采用哪一套；容量冲突会在写入后立即重算，候补按提交顺序排队，不会挤掉已确认场次。"
        />
        {pending.length === 0 ? (
          <Empty description="当前没有待定场次" />
        ) : (
          <Table<MergePendingRow>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={pending}
            columns={columns}
            scroll={{ x: 1000 }}
          />
        )}
      </Space>
    </Modal>
  );
}
