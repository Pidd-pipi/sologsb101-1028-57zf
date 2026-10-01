/** /sessions 场次安排与参与乐手：按日期/棚号排期、容量核算、离线包按稳定编号合并 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  message
} from 'antd';
import { CloudUploadOutlined, PlusOutlined, ExportOutlined } from '@ant-design/icons';
import FilterBar from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import ImportPackageModal from '@/components/merge/ImportPackageModal';
import ExportPackageModal from '@/components/merge/ExportPackageModal';
import MergePendingPanel from '@/components/merge/MergePendingPanel';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useSessionStore } from '@/stores/sessionStore';
import { useProjectStore } from '@/stores/projectStore';
import { useImportStore } from '@/stores/importStore';
import {
  db,
  type ImportDraftRow,
  type MergePendingRow,
  type ProjectRow,
  type SessionRow,
  type SongRow,
  type TakeRow
} from '@/utils/db';
import {
  SESSION_PERIODS,
  SESSION_STATES,
  STUDIO_ROOMS,
  countMusicians,
  createEmptySession,
  roomCapacityOf,
  type SessionInput
} from '@/types/session';
import type { FilterModel, FilterSelectConfig } from '@/types/filter';
import type { MergeResult } from '@/types/merge';
import { formatDuration, totalDuration } from '@/utils/timecode';
import { slotFreeSeats, waitlistRank } from '@/utils/capacity';

const asArray = (value: string | string[] | boolean | undefined): string[] => (Array.isArray(value) ? value : []);

export default function SessionPlan() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sessions = useIdbTable<SessionRow>(db.sessions);
  const songs = useIdbTable<SongRow>(db.songs);
  const projects = useIdbTable<ProjectRow>(db.projects);
  const takes = useIdbTable<TakeRow>(db.takes);
  const pending = useIdbTable<MergePendingRow>(db.mergePending, (a, b) => a.createdAt - b.createdAt);
  const drafts = useIdbTable<ImportDraftRow>(db.importDrafts, (a, b) => a.updatedAt - b.updatedAt);

  const filters = useSessionStore((state) => state.filters);
  const setFilters = useSessionStore((state) => state.setFilters);
  const resetFilters = useSessionStore((state) => state.resetFilters);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const selectSession = useSessionStore((state) => state.selectSession);
  const createSession = useSessionStore((state) => state.createSession);
  const editSession = useSessionStore((state) => state.editSession);
  const deleteSession = useSessionStore((state) => state.deleteSession);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const lastResult = useImportStore((state) => state.lastResult);
  const dropDraft = useImportStore((state) => state.dropDraft);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SessionRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [form] = Form.useForm<SessionInput>();

  useEffect(() => {
    setFilters({
      keyword: searchParams.get('keyword') ?? '',
      rooms: searchParams.get('rooms') ? (searchParams.get('rooms') as string).split(',') : [],
      periods: searchParams.get('periods') ? (searchParams.get('periods') as string).split(',') : [],
      states: searchParams.get('states') ? (searchParams.get('states') as string).split(',') : []
    });
    // 仅首次挂载还原 URL 筛选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selects: FilterSelectConfig[] = useMemo(
    () => [
      { key: 'rooms', label: '棚号', options: STUDIO_ROOMS.map((item) => ({ label: item, value: item })) },
      { key: 'periods', label: '时段', options: SESSION_PERIODS.map((item) => ({ label: item, value: item })) },
      { key: 'states', label: '状态', options: SESSION_STATES.map((item) => ({ label: item, value: item })) }
    ],
    []
  );

  function applyFilters(next: FilterModel): void {
    setFilters(next);
    const params: Record<string, string> = {};
    if (String(next.keyword ?? '').length > 0) params.keyword = String(next.keyword);
    asArray(next.rooms).length > 0 && (params.rooms = asArray(next.rooms).join(','));
    asArray(next.periods).length > 0 && (params.periods = asArray(next.periods).join(','));
    asArray(next.states).length > 0 && (params.states = asArray(next.states).join(','));
    setSearchParams(params, { replace: true });
  }

  const songOf = (songId: string): SongRow | null => songs.find((item) => item.id === songId) ?? null;
  const projectNameOf = (songId: string): string => {
    const song = songOf(songId);
    const project = song ? projects.find((item) => item.id === song.projectId) : undefined;
    return project ? project.name : '项目已删除';
  };

  const filtered = useMemo(() => {
    const keyword = String(filters.keyword ?? '').trim().toLowerCase();
    const rooms = asArray(filters.rooms);
    const periods = asArray(filters.periods);
    const states = asArray(filters.states);
    return sessions.filter((session) => {
      const song = songOf(session.songId);
      const label = `${song ? song.title : ''} ${projectNameOf(session.songId)} ${session.engineer} ${session.musicians} ${session.roomNo}`.toLowerCase();
      if (keyword && !label.includes(keyword)) return false;
      if (rooms.length > 0 && !rooms.includes(session.roomNo)) return false;
      if (periods.length > 0 && !periods.includes(session.period)) return false;
      if (states.length > 0 && !states.includes(session.state)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, songs, projects, filters]);

  const scopedSessions = currentProjectId
    ? filtered.filter((session) => songOf(session.songId)?.projectId === currentProjectId)
    : filtered;

  /** 同一槽位出现两场及以上「已确认」场次才算硬冲突（候补排队不算冲突） */
  const conflicts = useMemo(() => {
    const seen = new Map<string, number>();
    sessions.forEach((session) => {
      if (session.state !== '已排期' && session.state !== '已完成') return;
      const key = `${session.roomNo}|${session.date}|${session.period}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    });
    return Array.from(seen.entries())
      .filter(([, count]) => count > 1)
      .map(([key]) => key.replace(/\|/g, ' · '));
  }, [sessions]);

  const waitlistTotal = useMemo(() => sessions.filter((item) => item.state === '候补').length, [sessions]);
  const packageTotal = useMemo(() => sessions.filter((item) => item.source === 'package').length, [sessions]);

  const totals = useMemo(() => {
    const scopedIds = new Set(scopedSessions.map((session) => session.id));
    const relevantTakes = takes.filter((take) => scopedIds.has(take.sessionId));
    return {
      sessionCount: scopedSessions.length,
      scheduled: scopedSessions.filter((item) => item.state === '已排期').length,
      done: scopedSessions.filter((item) => item.state === '已完成').length,
      waitlist: scopedSessions.filter((item) => item.state === '候补').length,
      musicianSlots: scopedSessions
        .filter((item) => item.state !== '已取消' && item.state !== '候补')
        .reduce((sum, item) => sum + countMusicians(item.musicians), 0),
      durationText: formatDuration(totalDuration(relevantTakes))
    };
  }, [scopedSessions, takes]);

  async function submit(): Promise<void> {
    const values = await form.validateFields();
    setError(null);
    try {
      if (editing) {
        await editSession(editing.id, values);
        message.success('场次已更新，容量已重新核算');
      } else {
        await createSession(values);
        message.success('场次已提交，容量不足时将自动按提交顺序候补');
      }
      setDialogOpen(false);
      setEditing(null);
      form.resetFields();
    } catch (submitError) {
      const text = submitError instanceof Error ? submitError.message : '保存失败';
      setError(text);
      message.error(text);
    }
  }

  function startEdit(row: SessionRow): void {
    setEditing(row);
    setError(null);
    form.setFieldsValue({
      songId: row.songId,
      date: row.date,
      period: row.period,
      engineer: row.engineer,
      roomNo: row.roomNo,
      musicians: row.musicians,
      state: row.state
    });
    setDialogOpen(true);
  }

  function startCreate(): void {
    setEditing(null);
    setError(null);
    form.setFieldsValue({
      ...createEmptySession(),
      songId: songs.find((song) => song.projectId === currentProjectId)?.id ?? songs[0]?.id ?? ''
    });
    setDialogOpen(true);
  }

  function handleMerged(result: MergeResult): void {
    setImportOpen(false);
    if (result.pendingCount > 0) setPendingOpen(true);
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">场次安排与参与乐手</h2>
          <p className="page__subtitle">
            外勤离线包按稳定编号合并，不覆盖当天安排；棚号 / 乐手一变容量立即重算，容量不足的场次按提交顺序候补，不挤掉已确认场次。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ExportOutlined />} onClick={() => setExportOpen(true)}>
            导出离线包
          </Button>
          <Button type="primary" ghost icon={<CloudUploadOutlined />} onClick={() => setImportOpen(true)}>
            导入离线包
          </Button>
          <Button type="primary" icon={<PlusOutlined />} disabled={songs.length === 0} onClick={startCreate}>
            新增场次
          </Button>
        </Space>
      </div>

      <div className="badge-row">
        <StatBadge label="场次数" value={totals.sessionCount} suffix="场" tone="primary" icon="files" />
        <StatBadge label="已排期" value={totals.scheduled} suffix="场" tone="warning" icon="grid" />
        <StatBadge label="已完成" value={totals.done} suffix="场" tone="success" icon="histogram" />
        <StatBadge label="候补排队" value={waitlistTotal} suffix="场" tone="danger" icon="warning" />
        <StatBadge label="待定裁决" value={pending.length} suffix="条" tone="warning" icon="warning" />
        <StatBadge label="离线包来源" value={packageTotal} suffix="场" tone="info" icon="trend" />
        <StatBadge label="已录时长" value={totals.durationText} tone="default" icon="pie" />
      </div>

      {drafts.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message={`检测到 ${drafts.length} 个导入中断草稿，已保住数据`}
          description={
            <Space direction="vertical" size={4}>
              {drafts.map((draft) => (
                <Space key={draft.id}>
                  <span>
                    编号 {draft.packageNo}（{draft.origin}）上次导入中断，重新导入同一编号即可接着处理。
                  </span>
                  <Button
                    size="small"
                    type="link"
                    onClick={() => {
                      setImportOpen(true);
                    }}
                  >
                    去续写
                  </Button>
                  <Button
                    size="small"
                    type="link"
                    danger
                    onClick={async () => {
                      await dropDraft(draft.packageNo);
                      message.success('草稿已放弃');
                    }}
                  >
                    放弃草稿
                  </Button>
                </Space>
              ))}
            </Space>
          }
        />
      ) : null}

      {pending.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${pending.length} 条同场次两套值的待定记录，制作人选定前未写正式排期`}
          action={
            <Button size="small" type="primary" onClick={() => setPendingOpen(true)}>
              去裁决
            </Button>
          }
        />
      ) : null}

      {lastResult ? (
        <Alert
          type="success"
          showIcon
          message={`离线包 ${lastResult.packageNo}（${lastResult.origin}）合并完成${lastResult.resumed ? '（中断续写）' : ''}`}
          description={`新增曲目 ${lastResult.addedSongs}、场次 ${lastResult.addedSessions}、Take ${lastResult.addedTakes}、优选 ${lastResult.addedPicks}、补录 ${lastResult.addedRetakes}；待定 ${lastResult.pendingCount} 条，候补 ${lastResult.waitlistCount} 场。`}
        />
      ) : null}

      {conflicts.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`检测到 ${conflicts.length} 处棚号时段硬冲突（同槽位两场已确认）`}
          description={conflicts.join('；')}
        />
      ) : null}

      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} /> : null}

      <FilterBar
        modelValue={filters}
        selects={selects}
        keywordPlaceholder="搜索曲目 / 项目 / 录音师 / 乐手…"
        onChange={applyFilters}
        onReset={() => {
          resetFilters();
          setSearchParams({}, { replace: true });
        }}
      />

      {scopedSessions.length === 0 ? (
        <EmptyPanel
          title="暂无场次安排"
          description="为曲目安排录制场次，或导入外勤带回的离线包按稳定编号合并。"
          createText="新增场次"
          showCreate={songs.length > 0}
          onCreate={startCreate}
        />
      ) : (
        <Card
          title={
            <Space wrap>
              <span>场次清单（{scopedSessions.length}）</span>
              {waitlistTotal > 0 ? <Tag color="red">候补 {waitlistTotal}</Tag> : null}
              {pending.length > 0 ? (
                <Tag color="orange" style={{ cursor: 'pointer' }} onClick={() => setPendingOpen(true)}>
                  待定 {pending.length}
                </Tag>
              ) : null}
            </Space>
          }
        >
          <Table<SessionRow>
            rowKey="id"
            dataSource={scopedSessions}
            pagination={false}
            rowClassName={(row) => (row.id === currentSessionId ? 'take-row-selected' : '')}
            onRow={(row) => ({ onClick: () => selectSession(row.id) })}
            columns={[
              {
                title: '曲目 / 项目',
                minWidth: 200,
                render: (_, row) => (
                  <div>
                    <div>{songOf(row.songId)?.title ?? '曲目已删除'}</div>
                    <div className="muted">{projectNameOf(row.songId)}</div>
                  </div>
                )
              },
              { title: '日期', dataIndex: 'date', width: 110 },
              { title: '时段', dataIndex: 'period', width: 80 },
              {
                title: '棚号 / 容量',
                width: 120,
                render: (_, row) => (
                  <Space direction="vertical" size={0}>
                    <span>{row.roomNo}</span>
                    <span className="muted">{countMusicians(row.musicians)}/{roomCapacityOf(row.roomNo)} 席</span>
                  </Space>
                )
              },
              { title: '录音师', dataIndex: 'engineer', width: 90 },
              { title: '参与乐手', dataIndex: 'musicians', minWidth: 180 },
              {
                title: '来源',
                width: 90,
                render: (_, row) =>
                  row.source === 'package' ? <Tag color="blue">离线包</Tag> : <Tag color="green">本地</Tag>
              },
              {
                title: '状态',
                width: 110,
                render: (_, row) => {
                  if (row.state === '候补') {
                    const rank = waitlistRank(sessions, row);
                    const free = slotFreeSeats(sessions, row);
                    return (
                      <Space direction="vertical" size={0}>
                        <Tag color="red">候补 #{rank}</Tag>
                        <span className="muted">槽位余 {free} 席</span>
                      </Space>
                    );
                  }
                  return (
                    <Tag color={row.state === '已完成' ? 'green' : row.state === '已取消' ? 'default' : 'blue'}>
                      {row.state}
                    </Tag>
                  );
                }
              },
              {
                title: 'Take 条数',
                width: 90,
                render: (_, row) => takes.filter((take) => take.sessionId === row.id).length
              },
              {
                title: '操作',
                width: 150,
                render: (_, row) => (
                  <Space onClick={(event) => event.stopPropagation()}>
                    <Button type="link" size="small" onClick={() => startEdit(row)}>
                      编辑
                    </Button>
                    <Popconfirm
                      title="删除该场次？"
                      description="会级联删除其 Take 与对应优选"
                      onConfirm={async () => {
                        await deleteSession(row.id);
                        message.success('场次已删除，容量已重新核算');
                      }}
                    >
                      <Button type="link" size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                )
              }
            ]}
          />
        </Card>
      )}

      <Modal
        open={dialogOpen}
        title={editing ? '编辑场次' : '新增场次'}
        onCancel={() => setDialogOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="songId" label="曲目" rules={[{ required: true, message: '请选择曲目' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={songs.map((song) => ({
                label: `${song.title}（${projects.find((item) => item.id === song.projectId)?.name ?? '未知项目'}）`,
                value: song.id
              }))}
            />
          </Form.Item>
          <Space size={12}>
            <Form.Item name="date" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
              <Input type="date" style={{ width: 170 }} />
            </Form.Item>
            <Form.Item name="period" label="时段" rules={[{ required: true }]}>
              <Select style={{ width: 120 }} options={SESSION_PERIODS.map((item) => ({ label: item, value: item }))} />
            </Form.Item>
            <Form.Item name="roomNo" label="棚号" rules={[{ required: true }]}>
              <Select style={{ width: 150 }} options={STUDIO_ROOMS.map((item) => ({ label: item, value: item }))} />
            </Form.Item>
          </Space>
          <Form.Item name="engineer" label="录音师" rules={[{ required: true, message: '请填写录音师' }]}>
            <Input placeholder="如：赵鸣" />
          </Form.Item>
          <Form.Item name="musicians" label="参与乐手（顿号分隔，决定席位需求）">
            <Input placeholder="如：鼓：许峰、贝斯：黎川" />
          </Form.Item>
          <Form.Item name="state" label="场次状态" rules={[{ required: true }]}>
            <Select options={SESSION_STATES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
        </Form>
      </Modal>

      <ImportPackageModal open={importOpen} onClose={() => setImportOpen(false)} onMerged={handleMerged} />
      <ExportPackageModal open={exportOpen} onClose={() => setExportOpen(false)} />
      <MergePendingPanel open={pendingOpen} onClose={() => setPendingOpen(false)} />
    </div>
  );
}
