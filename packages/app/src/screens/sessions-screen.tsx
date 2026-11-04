import { useMemo, useState, useCallback, useEffect, type ReactElement } from "react";
import { View, Text } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronLeft, Sparkles } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AgentList } from "@/components/agent-list";
import { SearchField } from "@/components/ui/search-field";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { type AgentHistoryHostError, useAgentHistory } from "@/hooks/use-agent-history";
import {
  type AgentHistoryAiRankState,
  useAgentHistoryAiRank,
} from "@/hooks/use-agent-history-ai-rank";
import {
  type AgentHistorySearchProgress,
  useAgentHistorySearchStatus,
} from "@/hooks/use-agent-history-search-status";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useHosts } from "@/runtime/host-runtime";
import { buildOpenProjectRoute } from "@/utils/host-routes";

/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 200;

const sessionsHostOptionTestID = (serverId: string) => `sessions-host-filter-item-${serverId}`;

/**
 * A host that failed while others answered. Without this the list silently
 * under-reports, and under a query "No sessions match" becomes a claim the app
 * has no basis for.
 */
function SessionHostErrorsBanner({
  errors,
  t,
}: {
  errors: AgentHistoryHostError[];
  t: TFunction;
}): ReactElement {
  return (
    <View style={styles.errorsBannerWrap}>
      <View style={styles.errorsBanner} testID="sessions-host-errors">
        {errors.map((error) => (
          <Text key={error.serverId} style={styles.errorsBannerText}>
            {t("sessions.hostLoadFailed", { host: error.serverName })}
          </Text>
        ))}
      </View>
    </View>
  );
}

/**
 * Daseo delta 79: the one line under the filters that says why results may be
 * partial. The most actionable fact wins; nothing is said once the index is
 * complete.
 */
function resolveSearchStatusText(input: {
  t: TFunction;
  progress: AgentHistorySearchProgress | null;
  aiRank: AgentHistoryAiRankState;
}): string | null {
  const { t, progress } = input;
  if (input.aiRank.status === "failed") return t("sessions.status.aiFailed");
  if (!progress) return null;
  if (progress.keywordIndexing) {
    return t("sessions.status.indexing", progress.keywordIndexing);
  }
  switch (progress.semantic.state) {
    case "downloading":
      return t("sessions.status.semanticDownloading", { percent: progress.semantic.percent });
    case "indexing":
      return t("sessions.status.semanticIndexing", {
        embedded: progress.semantic.embedded,
        total: progress.semantic.total,
      });
    case "failed":
      return t("sessions.status.semanticFailed");
    case "ready":
    case "off":
      return null;
  }
}

function AiSearchButton({
  visible,
  state,
  disabled,
  onRun,
  onReset,
  t,
}: {
  visible: boolean;
  state: AgentHistoryAiRankState;
  disabled: boolean;
  onRun: () => void;
  onReset: () => void;
  t: TFunction;
}): ReactElement | null {
  const isCompact = useIsCompactFormFactor();
  const ranked = state.status === "ranked";
  const ranking = state.status === "ranking";
  const accessibilityState = useMemo(
    () => ({ selected: ranked, busy: ranking }),
    [ranked, ranking],
  );
  if (!visible) return null;
  let label = t("sessions.actions.aiSearch");
  if (ranking) label = t("sessions.actions.aiSearching");
  else if (ranked) label = t("sessions.actions.aiOrder");
  return (
    <Button
      variant={ranked ? "secondary" : "ghost"}
      size="sm"
      leftIcon={Sparkles}
      loading={ranking}
      disabled={disabled || ranking}
      onPress={ranked ? onReset : onRun}
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      testID="sessions-ai-search"
    >
      {isCompact ? null : label}
    </Button>
  );
}

/**
 * Daseo delta 79: the line under the filters. Its height is reserved whenever
 * the host has these features, so a status arriving never moves the list.
 */
function SessionsOptionsRow({
  visible,
  statusText,
  showSubagentToggle,
  includeSubagents,
  onIncludeSubagentsChange,
  t,
}: {
  visible: boolean;
  statusText: string | null;
  showSubagentToggle: boolean;
  includeSubagents: boolean;
  onIncludeSubagentsChange: (value: boolean) => void;
  t: TFunction;
}): ReactElement | null {
  if (!visible) return null;
  return (
    <View style={styles.optionsRow}>
      <Text style={styles.statusText} numberOfLines={1} testID="sessions-search-status">
        {statusText ?? ""}
      </Text>
      {showSubagentToggle ? (
        <View style={styles.subagentToggle}>
          <Text style={styles.subagentToggleLabel}>{t("sessions.includeSubagents")}</Text>
          <Switch
            value={includeSubagents}
            onValueChange={onIncludeSubagentsChange}
            accessibilityLabel={t("sessions.includeSubagents")}
            testID="sessions-include-subagents"
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Daseo delta 79: what a query adds on top of the list: index progress, the AI
 * order, and the per-row explanations. Nothing at rest.
 */
function useSessionsSearchAssist(input: {
  t: TFunction;
  search: string;
  isSearching: boolean;
  isContentSearchSupported: boolean;
  history: ReturnType<typeof useAgentHistory>;
}) {
  const { t, search, isSearching, history } = input;
  const { refreshAll } = history;
  const handleSettled = useCallback(() => void refreshAll(), [refreshAll]);
  const progress = useAgentHistorySearchStatus({
    serverIds: history.targetServerIds,
    enabled: input.isContentSearchSupported && isSearching,
    onSettled: handleSettled,
  });
  const aiRank = useAgentHistoryAiRank({
    query: isSearching ? search : "",
    agents: history.agents,
  });
  const statusText = isSearching
    ? resolveSearchStatusText({ t, progress, aiRank: aiRank.state })
    : null;
  const decorations = useMemo(
    () =>
      isSearching
        ? {
            searchMatchesByAgentKey: history.searchMatchesByAgentKey,
            searchSnippetsByAgentKey: history.searchSnippetsByAgentKey,
            searchSourcesByAgentKey: history.searchSourcesByAgentKey,
          }
        : {},
    [
      history.searchMatchesByAgentKey,
      history.searchSnippetsByAgentKey,
      history.searchSourcesByAgentKey,
      isSearching,
    ],
  );
  const listedAgents = isSearching ? aiRank.orderedAgents : history.agents;
  return {
    aiRank,
    // The model re-orders matches; with fewer than two there is nothing to order.
    canRankWithAi: isSearching && listedAgents.length >= 2,
    listedAgents,
    statusText,
    decorations,
  };
}

/** An empty list means something different once a query is narrowing it. */
function resolveEmptyText(input: {
  t: TFunction;
  isSearching: boolean;
  isAllHosts: boolean;
}): string {
  if (input.isSearching) return input.t("sessions.noMatches");
  if (input.isAllHosts) return input.t("sessions.empty");
  return "No sessions for this host";
}

export function SessionsScreen() {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <SessionsScreenContent />;
}

function SessionsScreenContent() {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const hosts = useHosts();
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const [searchInput, setSearchInput] = useState("");
  const [includeSubagents, setIncludeSubagents] = useState(false);
  const search = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS).trim();
  const historyServerId = selectedHost === ALL_HOSTS_OPTION_ID ? null : selectedHost;
  const history = useAgentHistory({
    serverId: historyServerId,
    search,
    includeSubagents,
  });
  const {
    agents,
    hasMore,
    isInitialLoad,
    isLoadingMore,
    isError,
    isSearchSupported,
    isSearchTruncated,
    isSubagentFilterSupported,
    isContentSearchSupported,
    isAiRankSupported,
    hostErrors,
    loadMore,
    refreshAll,
  } = history;
  const isSearching = isSearchSupported && search.length > 0;
  const { aiRank, canRankWithAi, listedAgents, statusText, decorations } = useSessionsSearchAssist({
    t,
    search,
    isSearching,
    isContentSearchSupported,
    history,
  });

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    void refreshAll().finally(() => setIsManualRefresh(false));
  }, [refreshAll]);

  // `useAgentHistory` owns the order: recency at rest, relevance under a query.
  const emptyText = resolveEmptyText({
    t,
    isSearching,
    isAllHosts: selectedHost === ALL_HOSTS_OPTION_ID,
  });
  const showHostFilter = hosts.length > 1;
  const showFilterRow = showHostFilter || isSearchSupported;
  const showLoadError = isError && agents.length === 0;

  const handleBack = useCallback(() => {
    router.navigate(buildOpenProjectRoute());
  }, []);

  const handleClearSearch = useCallback(() => setSearchInput(""), []);

  const listFooterComponent = useMemo(() => {
    // A ranked result set has no next page — reaching a weaker match means
    // narrowing the query, so the footer says that instead of offering a button.
    if (isSearchTruncated) {
      return (
        <View style={styles.footer}>
          <Text style={styles.footerHint}>{t("sessions.tooManyMatches")}</Text>
        </View>
      );
    }
    if (!hasMore) {
      return null;
    }
    return (
      <View style={styles.footer}>
        <Button variant="ghost" onPress={loadMore} disabled={isLoadingMore}>
          {isLoadingMore ? "Loading..." : t("sessions.actions.loadMore")}
        </Button>
      </View>
    );
  }, [hasMore, isLoadingMore, isSearchTruncated, loadMore, t]);

  return (
    <View style={styles.container}>
      <MenuHeader title={t("sessions.title")} />
      {showFilterRow ? (
        <View style={styles.filterContainer}>
          {isSearchSupported ? (
            <SearchField
              value={searchInput}
              onChangeText={setSearchInput}
              placeholder={t("sessions.searchPlaceholder")}
              clearAccessibilityLabel={t("sessions.actions.clearSearch")}
              testID="sessions-search-input"
              clearTestID="sessions-search-clear"
            />
          ) : null}
          <AiSearchButton
            visible={isAiRankSupported}
            state={aiRank.state}
            disabled={!canRankWithAi}
            onRun={aiRank.run}
            onReset={aiRank.reset}
            t={t}
          />
          {showHostFilter ? (
            <HostFilter
              hosts={hosts}
              selectedHost={selectedHost}
              onSelectHost={setSelectedHost}
              triggerTestID="sessions-host-filter-trigger"
              hostOptionTestID={sessionsHostOptionTestID}
            />
          ) : null}
        </View>
      ) : null}
      <SessionsOptionsRow
        visible={isSubagentFilterSupported || isContentSearchSupported}
        statusText={statusText}
        showSubagentToggle={isSubagentFilterSupported}
        includeSubagents={includeSubagents}
        onIncludeSubagentsChange={setIncludeSubagents}
        t={t}
      />
      {hostErrors.length > 0 ? <SessionHostErrorsBanner errors={hostErrors} t={t} /> : null}
      {isInitialLoad ? (
        <View style={styles.loadingContainer}>
          <LoadingSpinner size="large" color={theme.colors.foregroundMuted} />
        </View>
      ) : null}
      {!isInitialLoad && showLoadError ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>Unable to load sessions</Text>
          <Button variant="ghost" onPress={handleRefresh}>
            Try again
          </Button>
        </View>
      ) : null}
      {!isInitialLoad && !showLoadError && agents.length === 0 ? (
        <View style={styles.emptyContainer} testID="sessions-empty">
          <Text style={styles.emptyText}>{emptyText}</Text>
          {isSearching ? (
            <Button variant="ghost" onPress={handleClearSearch}>
              {t("sessions.actions.clearSearch")}
            </Button>
          ) : (
            <Button variant="ghost" leftIcon={ChevronLeft} onPress={handleBack}>
              Back
            </Button>
          )}
        </View>
      ) : null}
      {!isInitialLoad && !showLoadError && agents.length > 0 ? (
        <AgentList
          agents={listedAgents}
          showCheckoutInfo={false}
          isRefreshing={isManualRefresh}
          onRefresh={handleRefresh}
          listFooterComponent={listFooterComponent}
          showAttentionIndicator={false}
          showHostColumn
          {...decorations}
          flat={isSearching}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  filterContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
  },
  optionsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    minHeight: theme.spacing[8],
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[2],
  },
  statusText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  subagentToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  subagentToggleLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  footer: {
    alignItems: "center",
    paddingVertical: theme.spacing[4],
  },
  footerHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorsBannerWrap: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[3],
  },
  errorsBanner: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
}));
