import { c as _c } from "react/compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { useEffect } from 'react';
import { Box, Text } from '../../ink.js';
import { errorMessage } from '../../utils/errors.js';
import { logError } from '../../utils/log.js';
import { collectContentValidationResults, validateManifest } from '../../utils/plugins/validatePlugin.js';
import { plural } from '../../utils/stringUtils.js';
type Props = {
  onComplete: (result?: string) => void;
  path?: string;
};
export function ValidatePlugin(t0) {
  const $ = _c(5);
  const {
    onComplete,
    path
  } = t0;
  let t1;
  let t2;
  if ($[0] !== onComplete || $[1] !== path) {
    t1 = () => {
      const runValidation = async function runValidation() {
        if (!path) {
          onComplete("Usage: /plugin validate <path>\n\nValidate a plugin or marketplace manifest file or directory.\n\nExamples:\n  /plugin validate .claude-plugin/plugin.json\n  /plugin validate /path/to/plugin-directory\n  /plugin validate .\n\nWhen given a directory, automatically validates .claude-plugin/marketplace.json\nor .claude-plugin/plugin.json (both, and the plugin, if both exist).\n\nOr from the command line:\n  occ plugin validate <path>");
          return;
        }
        ;
        try {
          const result = await validateManifest(path);
          let output = "";
          output = output + `Validating ${result.fileType} manifest: ${result.filePath}\n\n`;
          output;
          if (result.errors.length > 0) {
            output = output + `${figures.cross} Found ${result.errors.length} ${plural(result.errors.length, "error")}:\n\n`;
            output;
            result.errors.forEach(error_0 => {
              output = output + `  ${figures.pointer} ${error_0.path}: ${error_0.message}\n`;
              output;
            });
            output = output + "\n";
            output;
          }
          if (result.warnings.length > 0) {
            output = output + `${figures.warning} Found ${result.warnings.length} ${plural(result.warnings.length, "warning")}:\n\n`;
            output;
            result.warnings.forEach(warning => {
              output = output + `  ${figures.pointer} ${warning.path}: ${warning.message}\n`;
              output;
            });
            output = output + "\n";
            output;
          }

          // OCC-107 acceptance-fix ③: splice in the co-located plugin.json /
          // content-file results via the SAME shared composition the CLI
          // handler (src/cli/handlers/plugins.ts) uses, so the TUI finally
          // honors its help-text promise ("both, and the plugin, if both
          // exist") instead of printing a fake pass over a broken plugin.
          const contentResults = await collectContentValidationResults(path, result);
          for (const r of contentResults) {
            output = output + `Validating ${r.fileType}: ${r.filePath}\n\n`;
            output;
            if (r.errors.length > 0) {
              output = output + `${figures.cross} Found ${r.errors.length} ${plural(r.errors.length, "error")}:\n\n`;
              output;
              r.errors.forEach(error_1 => {
                output = output + `  ${figures.pointer} ${error_1.path}: ${error_1.message}\n`;
                output;
              });
              output = output + "\n";
              output;
            }
            if (r.warnings.length > 0) {
              output = output + `${figures.warning} Found ${r.warnings.length} ${plural(r.warnings.length, "warning")}:\n\n`;
              output;
              r.warnings.forEach(warning_1 => {
                output = output + `  ${figures.pointer} ${warning_1.path}: ${warning_1.message}\n`;
                output;
              });
              output = output + "\n";
              output;
            }
          }
          const allSuccess = result.success && contentResults.every(r => r.success);
          const hasWarnings = result.warnings.length > 0 || contentResults.some(r => r.warnings.length > 0);
          if (allSuccess) {
            if (hasWarnings) {
              output = output + `${figures.tick} Validation passed with warnings\n`;
              output;
            } else {
              output = output + `${figures.tick} Validation passed\n`;
              output;
            }
            process.exitCode = 0;
          } else {
            output = output + `${figures.cross} Validation failed\n`;
            output;
            process.exitCode = 1;
          }
          onComplete(output);
        } catch (t3) {
          const error = t3;
          process.exitCode = 2;
          logError(error);
          onComplete(`${figures.cross} Unexpected error during validation: ${errorMessage(error)}`);
        }
      };
      runValidation();
    };
    t2 = [onComplete, path];
    $[0] = onComplete;
    $[1] = path;
    $[2] = t1;
    $[3] = t2;
  } else {
    t1 = $[2];
    t2 = $[3];
  }
  useEffect(t1, t2);
  let t3;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Box flexDirection="column"><Text>Running validation...</Text></Box>;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  return t3;
}
