/**
 * 待定场次面板：同一场次本地与离线包有两套值时列在这里。
 * 制作人选定前不写正式排期；选定后写回并重算容量。
 */
import { useMemo } from 'react';
import { Button, Card, Space, Table, Tag, Typography, message } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useOfflineStore } from '@/stores/offlineStore';
import { db, type PendingSessionRow, type ProjectRow, type SessionRow, type SongRow } from '@/utils/db';

export default function PendingPanel() {
  const pendings = useIdbTable<PendingSessionRow>(db.pendingSessions);
  const sessions = useIdbTable<SessionRow>(db.sessions);
  const songs = useIdbTable<SongRow>(db.songs);
  const projects = useIdbTable<ProjectRow>(db.projects);
  const resolvePending = useOfflineStore((state) => state.resolvePending);

  const pendingList = useMemo(() => pendings.filter((item) => item.status === '待定'), [pendings]);

  const sessionOf = (stableId: string): SessionRow | undefined => sessions.find((item) => item.id === stableId);
  const songLabel = (session: SessionRow | undefined): string => {
    if (!session) return '场次已删除';
    const song = songs.find((item) => item.id === session.songId);
    if (!song) return '曲目已删除';
    const project = projects.find((item) => item.id === song.projectId);
    return `${song.title}${project ? ` · ${project.name}` : ''}`;
  };

  async function handleResolve(pendingId: string, choice: 'local' | 'package'): Promise<void> {
    try {
      await resolvePending(pendingId, choice);
      message.success(choice === 'local' ? '已采用本地现值' : '已采用离线包值');
    } catch (error) {
      message.error(`决议失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  if (pendingList.length === 0) return null;

  return (
    <Card
      title={
        <Space>
          <span>待定场次</span>
          <Tag color="orange">{pendingList.length}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            棚号 / 时段 / 乐手有两套值，制作人选定前不写正式排期
          </Typography.Text>
        </Space>
      }
    >
      <Table<PendingSessionRow>
        rowKey="id"
        dataSource={pendingList}
        pagination={false}
        size="small"
        columns={[
          {
            title: '场次',
            minWidth: 180,
            render: (_, row) => {
              const session = sessionOf(row.sessionStableId);
              return (
                <Space direction="vertical" size={2}>
                  <span>{songLabel(session)}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    编号 {row.sessionStableId} · 包 {row.packageNo}
                  </Typography.Text>
                </Space>
              );
            }
          },
          {
            title: '本地现值',
            minWidth: 200,
            render: (_, row) => (
              <Space direction="vertical" size={2}>
                <span>
                  {row.local.roomNo} · {row.local.period}
                </span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {row.local.musicians || '（未填乐手）'}
                </Typography.Text>
              </Space>
            )
          },
          {
            title: '离线包值',
            minWidth: 200,
            render: (_, row) => (
              <Space direction="vertical" size={2}>
                <span>
                  {row.pkg.roomNo} · {row.pkg.period}
                </span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {row.pkg.musicians || '（未填乐手）'}
                </Typography.Text>
              </Space>
            )
          },
          {
            title: '操作',
            width: 200,
            render: (_, row) => (
              <Space>
                <Button size="small" icon={<CheckOutlined />} onClick={() => handleResolve(row.id, 'local')}>
                  采用本地
                </Button>
                <Button size="small" type="primary" onClick={() => handleResolve(row.id, 'package')}>
                  采用离线
                </Button>
              </Space>
            )
          }
        ]}
      />
    </Card>
  );
}
