import capitalize from 'lodash-es/capitalize.js';
import * as React from 'react';
import { useMemo, useState } from 'react';
import { type Command, type CommandBase, type CommandResultDisplay, getCommandName, type PromptCommand } from '../../commands.js';
import { Box, Text, useInput, useTerminalFocus } from '../../ink.js';
import { SearchBox } from '../SearchBox.js';
import { estimateSkillFrontmatterTokens, getSkillsPath } from '../../skills/loadSkillsDir.js';
import { getDisplayPath } from '../../utils/file.js';
import { formatTokens } from '../../utils/format.js';
import { getSettingSourceName, type SettingSource } from '../../utils/settings/constants.js';
import { plural } from '../../utils/stringUtils.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Dialog } from '../design-system/Dialog.js';

// Skills are always PromptCommands with CommandBase properties
type SkillCommand = CommandBase & PromptCommand;
type SkillSource = SettingSource | 'plugin' | 'mcp';
type Props = {
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  commands: Command[];
};

function getSourceTitle(source: SkillSource): string {
  if (source === 'plugin') {
    return 'Plugin skills';
  }
  if (source === 'mcp') {
    return 'MCP skills';
  }
  return `${capitalize(getSettingSourceName(source))} skills`;
}

function getSourceSubtitle(source: SkillSource, skills: SkillCommand[]): string | undefined {
  // MCP skills show server names; file-based skills show filesystem paths.
  // Skill names are `<server>:<skill>`, not `mcp__<server>__…`.
  if (source === 'mcp') {
    const servers = [...new Set(skills.map(s => {
      const idx = s.name.indexOf(':');
      return idx > 0 ? s.name.slice(0, idx) : null;
    }).filter((n): n is string => n != null))];
    return servers.length > 0 ? servers.join(', ') : undefined;
  }
  const skillsPath = getDisplayPath(getSkillsPath(source, 'skills'));
  const hasCommandsSkills = skills.some(s => s.loadedFrom === 'commands_DEPRECATED');
  return hasCommandsSkills ? `${skillsPath}, ${getDisplayPath(getSkillsPath(source, 'commands'))}` : skillsPath;
}

// I12: typed character(s) that should extend the filter query. Excludes
// ctrl/meta combos and all special keys so e.g. arrow keys don't append
// their key name to the query.
function isPrintableInput(
  input: string,
  key: {
    ctrl?: boolean;
    meta?: boolean;
    escape?: boolean;
    backspace?: boolean;
    delete?: boolean;
    return?: boolean;
    tab?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
  },
): boolean {
  if (!input || input.length < 1) return false;
  if (key.ctrl || key.meta || key.escape || key.backspace || key.delete || key.return || key.tab) return false;
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return false;
  return true;
}

const GROUP_ORDER: SkillSource[] = ['projectSettings', 'userSettings', 'policySettings', 'plugin', 'mcp'];

export function SkillsMenu({ onExit, commands }: Props): React.ReactNode {
  const skills = useMemo(
    () => commands.filter((cmd): cmd is SkillCommand =>
      cmd.type === 'prompt' && (cmd.loadedFrom === 'skills' || cmd.loadedFrom === 'commands_DEPRECATED' || cmd.loadedFrom === 'plugin' || cmd.loadedFrom === 'mcp')),
    [commands],
  );

  // I12: press `t` to toggle sort between alphabetical and estimated
  // frontmatter token count. Token sort uses the same
  // estimateSkillFrontmatterTokens value already shown per skill.
  const [sortByTokens, setSortByTokens] = useState(false);
  // I12: `/` enters search mode; typed chars filter the list by name;
  // Esc clears the filter and exits search (or closes when not searching).
  const [filter, setFilter] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);
  const isTerminalFocused = useTerminalFocus();

  const handleCancel = React.useCallback(() => {
    onExit('Skills dialog dismissed', { display: 'system' });
  }, [onExit]);

  useInput((input, key) => {
    if (isSearchMode) {
      // Ctrl+C always closes, even while filtering (Dialog cedes confirm:no
      // while search owns the keyboard, so we handle it here).
      if (input === 'c' && key.ctrl) {
        handleCancel();
        return;
      }
      if (key.escape) {
        setFilter('');
        setIsSearchMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        if (filter.length > 0) {
          setFilter(prev => prev.slice(0, -1));
        } else {
          setIsSearchMode(false);
        }
        return;
      }
      if (isPrintableInput(input, key)) {
        setFilter(prev => prev + input);
      }
      return;
    }
    // Not in search mode: `/` enters search, `t` toggles sort.
    if (input === '/' && !key.ctrl && !key.meta) {
      setIsSearchMode(true);
      return;
    }
    if (input === 't' && !key.ctrl && !key.meta) {
      setSortByTokens(prev => !prev);
    }
  });

  const lowerFilter = filter.toLowerCase();
  const filteredSkills = useMemo(() => {
    if (!filter) return skills;
    return skills.filter(s => getCommandName(s).toLowerCase().includes(lowerFilter));
  }, [skills, filter, lowerFilter]);

  if (skills.length === 0) {
    return (
      <Dialog title="Skills" subtitle="No skills found" onCancel={handleCancel} hideInputGuide>
        <Text dimColor>Create skills in .claude/skills/ or ~/.claude/skills/</Text>
        <Text dimColor italic>
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="close" />
        </Text>
      </Dialog>
    );
  }

  // Group filtered skills by source, then sort within each group.
  const groups: Record<SkillSource, SkillCommand[]> = {
    policySettings: [],
    userSettings: [],
    projectSettings: [],
    localSettings: [],
    flagSettings: [],
    plugin: [],
    mcp: [],
  };
  for (const skill of filteredSkills) {
    const source = skill.source as SkillSource;
    if (source in groups) {
      groups[source].push(skill);
    }
  }
  for (const group of Object.values(groups)) {
    group.sort((a, b) => sortByTokens
      ? estimateSkillFrontmatterTokens(a) - estimateSkillFrontmatterTokens(b)
      : getCommandName(a).localeCompare(getCommandName(b)));
  }

  const renderSkill = (skill: SkillCommand): React.ReactNode => {
    const estimatedTokens = estimateSkillFrontmatterTokens(skill);
    const tokenDisplay = `~${formatTokens(estimatedTokens)}`;
    const pluginName = skill.source === 'plugin' ? skill.pluginInfo?.pluginManifest.name : undefined;
    return (
      <Box key={`${skill.name}-${skill.source}`}>
        <Text>{getCommandName(skill)}</Text>
        <Text dimColor>{pluginName ? ` · ${pluginName}` : ''} · {tokenDisplay} description tokens</Text>
      </Box>
    );
  };

  const renderSkillGroup = (source: SkillSource): React.ReactNode => {
    const groupSkills = groups[source];
    if (groupSkills.length === 0) return null;
    const title = getSourceTitle(source);
    const subtitle = getSourceSubtitle(source, groupSkills);
    return (
      <Box flexDirection="column" key={source}>
        <Box>
          <Text bold dimColor>{title}</Text>
          {subtitle && <Text dimColor> ({subtitle})</Text>}
        </Box>
        {groupSkills.map(renderSkill)}
      </Box>
    );
  };

  // Subtitle: filtered/total count + sort mode + hint. Matches the official
  // shape `${count}${sortedByTokens ? " · sorted by tokens" : ""} · ${hint}`.
  const filtering = filter.length > 0;
  const countText = filtering
    ? `${filteredSkills.length}/${skills.length} ${plural(skills.length, 'skill')}`
    : `${skills.length} ${plural(skills.length, 'skill')}`;
  const sortSuffix = sortByTokens ? ' · sorted by tokens' : '';
  const hint = isSearchMode
    ? 'type to filter · esc to clear'
    : `${sortByTokens ? 'by tokens' : 'alphabetical'} (press t to toggle) · / to search · esc to close`;
  const subtitle = `${countText}${sortSuffix} · ${hint}`;

  return (
    <Dialog title="Skills" subtitle={subtitle} onCancel={handleCancel} isCancelActive={!isSearchMode} hideInputGuide>
      <Box flexDirection="column" gap={1}>
        <SearchBox query={filter} isFocused={isSearchMode} isTerminalFocused={isTerminalFocused} cursorOffset={filter.length} placeholder="Search skills…" />
        {filtering && filteredSkills.length === 0 ? (
          <Text dimColor>{`No skills match "${filter}"`}</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            {GROUP_ORDER.map(renderSkillGroup)}
          </Box>
        )}
        <Text dimColor italic>
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="close" />
        </Text>
      </Box>
    </Dialog>
  );
}
