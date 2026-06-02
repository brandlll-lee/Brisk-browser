/**
 * All Brisk V0.1.0 tool registrations.
 *
 * 37 tools total:
 *   • navigation  : 8
 *   • observation : 6
 *   • input       : 9
 *   • waits       : 4
 *   • network     : 2
 *   • admin       : 3
 *   • skills      : 5
 */

import type { BriskTool } from '../framework.js';
import { adminTools } from './admin.js';
import { inputTools } from './input.js';
import { navigationTools } from './navigation.js';
import { networkTools } from './network.js';
import { observationTools } from './observation.js';
import { skillsTools } from './skills.js';
import { waitsTools } from './waits.js';

export const ALL_TOOLS: readonly BriskTool[] = [
  ...navigationTools,
  ...observationTools,
  ...inputTools,
  ...waitsTools,
  ...networkTools,
  ...adminTools,
  ...skillsTools,
];

export {
  adminTools,
  inputTools,
  navigationTools,
  networkTools,
  observationTools,
  skillsTools,
  waitsTools,
};
