(function () {
  'use strict';

  // =========================================================================
  // Constants
  // =========================================================================

  var STORAGE_PREFIX = 'avt.tagManager.';
  var ROUTE_PATH = '/plugins/tag-manager';
  var PLUGIN_ID = 'auto-vision-tagging';

  var ALL_COLUMNS = [
    { key: 'title',      label: 'Title',      on: true },
    { key: 'duration',   label: 'Duration',   on: true },
    { key: 'date',       label: 'Date',       on: true },
    { key: 'tags',       label: 'Tags',       on: true },
    { key: 'studio',     label: 'Studio',     on: false },
    { key: 'performers', label: 'Performers', on: false },
    { key: 'rating',     label: 'Rating',     on: false },
    { key: 'path',       label: 'File Path',  on: false },
  ];

  var SORT_OPTIONS = [
    { value: 'title',      label: 'Title' },
    { value: 'date',       label: 'Date' },
    { value: 'updated_at', label: 'Updated At' },
    { value: 'created_at', label: 'Created At' },
    { value: 'duration',   label: 'Duration' },
    { value: 'rating',     label: 'Rating' },
    { value: 'random',     label: 'Random' },
    { value: 'path',       label: 'Path' },
    { value: 'play_count', label: 'Play Count' },
    { value: 'tag_count',  label: 'Tag Count' },
  ];

  var PER_PAGE_OPTIONS = [20, 40, 60, 120, 250, 500];

  // =========================================================================
  // API references
  // =========================================================================

  var api = window.PluginApi;
  var React = api.React;
  var el = React.createElement;
  var GQL = api.GQL;

  var useState = React.useState;
  var useEffect = React.useEffect;
  var useMemo = React.useMemo;
  var useCallback = React.useCallback;
  var useRef = React.useRef;

  var Bootstrap = api.libraries.Bootstrap;
  var Button = Bootstrap.Button;
  var Table = Bootstrap.Table;
  var Badge = Bootstrap.Badge;
  var Modal = Bootstrap.Modal;
  var Form = Bootstrap.Form;
  var Dropdown = Bootstrap.Dropdown;
  var Spinner = Bootstrap.Spinner;
  var Pagination = Bootstrap.Pagination;
  var OverlayTrigger = Bootstrap.OverlayTrigger;
  var Tooltip = Bootstrap.Tooltip;

  var NavLink = api.libraries.ReactRouterDOM.NavLink;
  var Link = api.libraries.ReactRouterDOM.Link;

  var FA = api.libraries.FontAwesomeSolid;

  // =========================================================================
  // Utilities
  // =========================================================================

  function loadSetting(key, fallback) {
    try {
      var raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw !== null ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveSetting(key, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch (_) { /* quota exceeded — ignore */ }
  }

  function useLocalStorage(key, fallback) {
    var pair = useState(function () { return loadSetting(key, fallback); });
    var value = pair[0];
    var setValue = pair[1];
    useEffect(function () { saveSetting(key, value); }, [key, value]);
    return [value, setValue];
  }

  function formatDuration(seconds) {
    if (!seconds && seconds !== 0) return '';
    var s = Math.round(seconds);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    return m + ':' + String(sec).padStart(2, '0');
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      var d = new Date(dateStr);
      return d.toLocaleDateString();
    } catch (_) {
      return dateStr;
    }
  }

  // =========================================================================
  // useAllTags — fetch full tag list once for the include/exclude controls
  // =========================================================================

  function useAllTags() {
    var result = GQL.useFindTagsQuery({
      variables: { filter: { per_page: -1, sort: 'name', direction: GQL.SortDirectionEnum.Asc } },
    });
    return useMemo(function () {
      if (!result.data || !result.data.findTags) return [];
      return result.data.findTags.tags;
    }, [result.data]);
  }

  // =========================================================================
  // useResolvedTagSet — expand tag IDs with descendants when recursion is on
  // =========================================================================

  function useResolvedTagSet(tagIds, recurse, allTags) {
    return useMemo(function () {
      var set = new Set(tagIds);
      if (!recurse || tagIds.length === 0 || allTags.length === 0) return set;

      // Build parent→children map from allTags
      var childrenOf = {};
      allTags.forEach(function (tag) {
        if (tag.parents) {
          tag.parents.forEach(function (parent) {
            if (!childrenOf[parent.id]) childrenOf[parent.id] = [];
            childrenOf[parent.id].push(tag.id);
          });
        }
      });

      // BFS to collect all descendants of each selected tag
      var queue = tagIds.slice();
      while (queue.length > 0) {
        var current = queue.shift();
        var kids = childrenOf[current];
        if (kids) {
          kids.forEach(function (kid) {
            if (!set.has(kid)) {
              set.add(kid);
              queue.push(kid);
            }
          });
        }
      }
      return set;
    }, [tagIds, recurse, allTags]);
  }

  // =========================================================================
  // TagIncludeExcludeControl — unified tag picker with [+]/[-] per tag
  // =========================================================================

  function TagIncludeExcludeControl(props) {
    var allTags = props.allTags;
    var includedIds = props.includedIds;
    var excludedIds = props.excludedIds;
    var onIncludedChange = props.onIncludedChange;
    var onExcludedChange = props.onExcludedChange;

    var searchState = useState('');
    var search = searchState[0]; var setSearch = searchState[1];

    var includedSet = useMemo(function () { return new Set(includedIds); }, [includedIds]);
    var excludedSet = useMemo(function () { return new Set(excludedIds); }, [excludedIds]);

    var filteredTags = useMemo(function () {
      if (!search) return allTags;
      var lower = search.toLowerCase();
      return allTags.filter(function (t) { return t.name.toLowerCase().indexOf(lower) >= 0; });
    }, [allTags, search]);

    var tagNameMap = useMemo(function () {
      var m = {};
      allTags.forEach(function (t) { m[t.id] = t.name; });
      return m;
    }, [allTags]);

    function toggleInclude(id) {
      if (includedSet.has(id)) {
        onIncludedChange(includedIds.filter(function (x) { return x !== id; }));
      } else {
        // Remove from excluded if present
        if (excludedSet.has(id)) {
          onExcludedChange(excludedIds.filter(function (x) { return x !== id; }));
        }
        onIncludedChange(includedIds.concat(id));
      }
    }

    function toggleExclude(id) {
      if (excludedSet.has(id)) {
        onExcludedChange(excludedIds.filter(function (x) { return x !== id; }));
      } else {
        // Remove from included if present
        if (includedSet.has(id)) {
          onIncludedChange(includedIds.filter(function (x) { return x !== id; }));
        }
        onExcludedChange(excludedIds.concat(id));
      }
    }

    function removePill(id) {
      if (includedSet.has(id)) {
        onIncludedChange(includedIds.filter(function (x) { return x !== id; }));
      } else if (excludedSet.has(id)) {
        onExcludedChange(excludedIds.filter(function (x) { return x !== id; }));
      }
    }

    // Selected pills
    var pills = [];
    includedIds.forEach(function (id) {
      pills.push(el(Badge, {
        key: 'i-' + id,
        className: 'tm-tag-included',
        onClick: function () { removePill(id); },
        style: { cursor: 'pointer' },
      }, (tagNameMap[id] || id) + ' \u00d7'));
    });
    excludedIds.forEach(function (id) {
      pills.push(el(Badge, {
        key: 'e-' + id,
        className: 'tm-tag-excluded',
        onClick: function () { removePill(id); },
        style: { cursor: 'pointer' },
      }, (tagNameMap[id] || id) + ' \u00d7'));
    });

    return el('div', null,
      // Selected pills row
      pills.length > 0 && el('div', { className: 'tm-taxonomy-pills' }, pills),

      // Scrollable tag list
      el('div', { className: 'tm-tag-control' },
        el('div', { className: 'tm-tag-control-search' },
          el(Form.Control, {
            size: 'sm',
            type: 'text',
            placeholder: 'Search...',
            value: search,
            onChange: function (e) { setSearch(e.target.value); },
          })
        ),
        filteredTags.map(function (tag) {
          var isIncluded = includedSet.has(tag.id);
          var isExcluded = excludedSet.has(tag.id);
          return el('div', { key: tag.id, className: 'tm-tag-row' },
            el(Button, {
              variant: 'link',
              size: 'sm',
              className: 'btn-include' + (isIncluded ? ' active' : ''),
              onClick: function () { toggleInclude(tag.id); },
              title: 'Include',
            }, '+'),
            el('span', { className: 'tm-tag-name' + (isIncluded ? ' text-success' : isExcluded ? ' text-danger' : '') }, tag.name),
            el(Button, {
              variant: 'link',
              size: 'sm',
              className: 'btn-exclude' + (isExcluded ? ' active' : ''),
              onClick: function () { toggleExclude(tag.id); },
              title: 'Exclude',
            }, '\u2212')
          );
        })
      )
    );
  }

  // =========================================================================
  // idsToTagValues / tagValuesToIds — convert between ID arrays and TagSelect value objects
  // =========================================================================

  function idsToTagValues(ids, allTags) {
    var map = {};
    allTags.forEach(function (t) { map[t.id] = t; });
    return ids.map(function (id) { return map[id] || { id: id, name: id }; });
  }

  function tagValuesToIds(values) {
    return values.map(function (v) { return v.id; });
  }

  // =========================================================================
  // TaxonomyControl — compact dual-TagSelect bar for color-coding
  // =========================================================================

  function TaxonomyControl(props) {
    var allTags = props.allTags;
    var taxIncludeIds = props.taxIncludeIds;
    var taxExcludeIds = props.taxExcludeIds;
    var onIncludeChange = props.onIncludeChange;
    var onExcludeChange = props.onExcludeChange;
    var includeSubTags = props.includeSubTags;
    var onIncludeSubTagsChange = props.onIncludeSubTagsChange;
    var groupByMembership = props.groupByMembership;
    var onGroupByMembershipChange = props.onGroupByMembershipChange;

    var TagSelect = api.components.TagSelect;

    var includeValues = useMemo(function () { return idsToTagValues(taxIncludeIds, allTags); }, [taxIncludeIds, allTags]);
    var excludeValues = useMemo(function () { return idsToTagValues(taxExcludeIds, allTags); }, [taxExcludeIds, allTags]);

    // Exclude IDs from the other picker to prevent selecting a tag in both
    var excludeFromInclude = useMemo(function () { return taxExcludeIds; }, [taxExcludeIds]);
    var excludeFromExclude = useMemo(function () { return taxIncludeIds; }, [taxIncludeIds]);

    return el('div', { className: 'tm-taxonomy' },
      el('div', { className: 'tm-taxonomy-bar' },
        el('div', { className: 'tm-taxonomy-select tm-taxonomy-include' },
          el('label', { className: 'tm-taxonomy-label tm-label-include' }, 'Include'),
          el(TagSelect, {
            isMulti: true,
            onSelect: function (items) { onIncludeChange(tagValuesToIds(items)); },
            values: includeValues,
            excludeIds: excludeFromInclude,
          })
        ),
        el('div', { className: 'tm-taxonomy-select tm-taxonomy-exclude' },
          el('label', { className: 'tm-taxonomy-label tm-label-exclude' }, 'Exclude'),
          el(TagSelect, {
            isMulti: true,
            onSelect: function (items) { onExcludeChange(tagValuesToIds(items)); },
            values: excludeValues,
            excludeIds: excludeFromExclude,
          })
        ),
        el('div', { className: 'tm-taxonomy-options' },
          el(Form.Check, {
            type: 'checkbox',
            label: 'Sub-tags',
            checked: includeSubTags,
            onChange: function (e) { onIncludeSubTagsChange(e.target.checked); },
            id: 'tm-include-sub-tags',
          }),
          el(Form.Check, {
            type: 'checkbox',
            label: 'Group',
            checked: groupByMembership,
            onChange: function (e) { onGroupByMembershipChange(e.target.checked); },
            id: 'tm-group-membership',
          })
        )
      )
    );
  }

  // =========================================================================
  // getTagColorClass — resolve a tag's color class from taxonomy sets
  // =========================================================================

  function getTagColorClass(tagId, includeSet, excludeSet) {
    var isIn = includeSet.has(tagId);
    var isEx = excludeSet.has(tagId);
    if (isIn && isEx) return 'tm-tag-conflict';
    if (isIn) return 'tm-tag-included';
    if (isEx) return 'tm-tag-excluded';
    return 'tm-tag-neutral';
  }

  // =========================================================================
  // sortTagsByMembership — sort tags: included first, then neutral, then excluded
  // =========================================================================

  function sortTagsByMembership(tags, includeSet, excludeSet) {
    var order = { 'tm-tag-included': 0, 'tm-tag-neutral': 1, 'tm-tag-conflict': 1, 'tm-tag-excluded': 2 };
    return tags.slice().sort(function (a, b) {
      var ca = getTagColorClass(a.id, includeSet, excludeSet);
      var cb = getTagColorClass(b.id, includeSet, excludeSet);
      return (order[ca] || 1) - (order[cb] || 1);
    });
  }

  // =========================================================================
  // PaginationNav
  // =========================================================================

  function PaginationNav(props) {
    var currentPage = props.currentPage;
    var totalPages = props.totalPages;
    var onPageChange = props.onPageChange;
    var totalItems = props.totalItems;
    var perPage = props.perPage;

    if (totalPages <= 1 && !totalItems) return null;

    var countText = null;
    if (totalItems != null) {
      var start = totalItems === 0 ? 0 : (currentPage - 1) * perPage + 1;
      var end = Math.min(currentPage * perPage, totalItems);
      countText = el('span', { className: 'filter-container text-muted paginationIndex center-text' },
        start + '-' + end + ' of ' + totalItems
      );
    }

    if (totalPages <= 1) {
      return el('div', { className: 'pagination-index-container' }, countText);
    }

    function navBtn(label, page, disabled) {
      return el(Button, {
        key: label,
        variant: 'secondary',
        disabled: disabled,
        onClick: function () { onPageChange(page); },
      }, label);
    }

    return el('div', { className: 'pagination-index-container' },
      el('div', { className: 'pagination btn-group' },
        navBtn('\u00ab', 1, currentPage === 1),
        navBtn('\u2039', currentPage - 1, currentPage === 1),
        el('div', { key: 'count', className: 'page-count-container' },
          el('div', { className: 'btn-group' },
            el(Button, { variant: 'secondary' }, currentPage + ' of ' + totalPages)
          )
        ),
        navBtn('\u203a', currentPage + 1, currentPage === totalPages),
        navBtn('\u00bb', totalPages, currentPage === totalPages)
      ),
      countText
    );
  }

  // =========================================================================
  // SortControl
  // =========================================================================

  function SortControl(props) {
    var sortField = props.sortField;
    var sortDir = props.sortDir;
    var onSortFieldChange = props.onSortFieldChange;
    var onSortDirToggle = props.onSortDirToggle;

    return el('div', { className: 'sort-by-select dropdown btn-group', role: 'group' },
      el(Dropdown, null,
        el(Dropdown.Toggle, { variant: 'secondary', size: 'sm' },
          SORT_OPTIONS.find(function (o) { return o.value === sortField; })?.label || sortField
        ),
        el(Dropdown.Menu, null,
          SORT_OPTIONS.map(function (opt) {
            return el(Dropdown.Item, {
              key: opt.value,
              active: opt.value === sortField,
              onClick: function () { onSortFieldChange(opt.value); },
            }, opt.label);
          })
        )
      ),
      el(Button, {
        variant: 'secondary',
        size: 'sm',
        onClick: onSortDirToggle,
        title: sortDir === 'DESC' ? 'Descending' : 'Ascending',
      },
        el(api.components.Icon, { icon: sortDir === 'DESC' ? FA.faSortAmountDown : FA.faSortAmountUp })
      )
    );
  }

  // =========================================================================
  // PerPageSelect
  // =========================================================================

  function PerPageSelect(props) {
    return el(Form.Control, {
      as: 'select',
      size: 'sm',
      className: 'page-size-selector',
      value: props.value,
      onChange: function (e) { props.onChange(Number(e.target.value)); },
    },
      PER_PAGE_OPTIONS.map(function (n) {
        return el('option', { key: n, value: n }, n);
      })
    );
  }

  // =========================================================================
  // ColumnConfigDropdown
  // =========================================================================

  function ColumnConfigDropdown(props) {
    var visible = props.visible;
    var onChange = props.onChange;

    return el(Dropdown, null,
      el(Dropdown.Toggle, { variant: 'secondary', size: 'sm' },
        el(api.components.Icon, { icon: FA.faCog })
      ),
      el(Dropdown.Menu, null,
        ALL_COLUMNS.map(function (col) {
          return el(Dropdown.Item, {
            key: col.key,
            onClick: function (e) {
              e.stopPropagation();
              var next = visible.indexOf(col.key) >= 0
                ? visible.filter(function (k) { return k !== col.key; })
                : visible.concat(col.key);
              onChange(next);
            },
          },
            el(Form.Check, {
              type: 'checkbox',
              label: col.label,
              checked: visible.indexOf(col.key) >= 0,
              readOnly: true,
            })
          );
        })
      )
    );
  }

  // =========================================================================
  // EditFilterModal
  // =========================================================================

  function EditFilterModal(props) {
    var allTags = props.allTags;
    // Accordion: only one section open at a time (null = all closed)
    var openSectionState = useState('tags');
    var openSection = openSectionState[0]; var setOpenSection = openSectionState[1];
    function toggleSection(name) {
      setOpenSection(function (prev) { return prev === name ? null : name; });
    }
    var tagsOpen = openSection === 'tags';
    var pathOpen = openSection === 'path';
    var orgOpen = openSection === 'organized';

    var hasAnyFilter = props.filterTagIncludeIds.length > 0 ||
      props.filterTagExcludeIds.length > 0 ||
      props.filterPath ||
      props.filterOrganized !== null;

    function handleClear() {
      props.onFilterTagIncludeChange([]);
      props.onFilterTagExcludeChange([]);
      props.onFilterTagDepthChange(0);
      props.onFilterPathChange('');
      props.onFilterPathModifierChange('INCLUDES');
      props.onFilterOrganizedChange(null);
    }

    return el(Modal, {
      show: props.show,
      onHide: props.onClose,
      centered: true,
      size: 'lg',
      className: 'tm-filter-modal',
    },
      el(Modal.Header, { closeButton: true },
        el(Modal.Title, null, 'Edit Filter'),
        el('div', { style: { marginLeft: 'auto', paddingRight: '1rem' } },
          el(Form.Control, {
            size: 'sm',
            type: 'text',
            placeholder: 'Search...',
            style: { width: '200px' },
          })
        )
      ),
      el(Modal.Body, null,
        // Tags section
        el('div', { className: 'tm-filter-section' },
          el('div', {
            className: 'tm-filter-section-header',
            onClick: function () { toggleSection('tags'); },
          },
            el(api.components.Icon, { icon: tagsOpen ? FA.faChevronDown : FA.faChevronRight }),
            el('span', null, ' Tags'),
            props.filterTagIncludeIds.length + props.filterTagExcludeIds.length > 0 &&
              el(Badge, { variant: 'info', className: 'ml-2' },
                props.filterTagIncludeIds.length + props.filterTagExcludeIds.length
              )
          ),
          tagsOpen && el('div', { className: 'tm-filter-section-body' },
            el(Form.Check, {
              type: 'checkbox',
              label: 'Include sub-tags',
              checked: props.filterTagDepth === -1,
              onChange: function (e) { props.onFilterTagDepthChange(e.target.checked ? -1 : 0); },
              id: 'tm-filter-tag-depth',
              className: 'mb-2',
            }),
            el(TagIncludeExcludeControl, {
              allTags: allTags,
              includedIds: props.filterTagIncludeIds,
              excludedIds: props.filterTagExcludeIds,
              onIncludedChange: props.onFilterTagIncludeChange,
              onExcludedChange: props.onFilterTagExcludeChange,
            })
          )
        ),

        // Path section
        el('div', { className: 'tm-filter-section' },
          el('div', {
            className: 'tm-filter-section-header',
            onClick: function () { toggleSection('path'); },
          },
            el(api.components.Icon, { icon: pathOpen ? FA.faChevronDown : FA.faChevronRight }),
            el('span', null, ' Path'),
            props.filterPath && el(Badge, { variant: 'info', className: 'ml-2' }, '1')
          ),
          pathOpen && el('div', { className: 'tm-filter-section-body' },
            el('div', { className: 'd-flex align-items-center mb-2', style: { gap: '0.5rem' } },
              el(Form.Control, {
                as: 'select',
                size: 'sm',
                value: props.filterPathModifier,
                onChange: function (e) { props.onFilterPathModifierChange(e.target.value); },
                style: { width: 'auto' },
              },
                el('option', { value: 'INCLUDES' }, 'Contains'),
                el('option', { value: 'MATCHES_REGEX' }, 'Matches Regex')
              )
            ),
            el(Form.Control, {
              size: 'sm',
              type: 'text',
              placeholder: 'File path...',
              value: props.filterPath,
              onChange: function (e) { props.onFilterPathChange(e.target.value); },
            })
          )
        ),

        // Organized section
        el('div', { className: 'tm-filter-section' },
          el('div', {
            className: 'tm-filter-section-header',
            onClick: function () { toggleSection('organized'); },
          },
            el(api.components.Icon, { icon: orgOpen ? FA.faChevronDown : FA.faChevronRight }),
            el('span', null, ' Organized'),
            props.filterOrganized !== null && el(Badge, { variant: 'info', className: 'ml-2' }, '1')
          ),
          orgOpen && el('div', { className: 'tm-filter-section-body' },
            el(Form.Check, {
              type: 'radio',
              label: 'Any',
              name: 'tm-org',
              checked: props.filterOrganized === null,
              onChange: function () { props.onFilterOrganizedChange(null); },
              id: 'tm-org-any',
            }),
            el(Form.Check, {
              type: 'radio',
              label: 'Organized',
              name: 'tm-org',
              checked: props.filterOrganized === true,
              onChange: function () { props.onFilterOrganizedChange(true); },
              id: 'tm-org-yes',
            }),
            el(Form.Check, {
              type: 'radio',
              label: 'Not Organized',
              name: 'tm-org',
              checked: props.filterOrganized === false,
              onChange: function () { props.onFilterOrganizedChange(false); },
              id: 'tm-org-no',
            })
          )
        )
      ),
      el(Modal.Footer, null,
        hasAnyFilter && el(Button, { variant: 'outline-warning', size: 'sm', onClick: handleClear }, 'Clear All'),
        el(Button, { variant: 'secondary', size: 'sm', onClick: props.onClose }, 'Close')
      )
    );
  }

  // =========================================================================
  // Toolbar
  // =========================================================================

  function Toolbar(props) {
    return el('div', { className: 'tm-toolbar filtered-list-toolbar btn-toolbar', role: 'toolbar' },
      el(Button, {
        variant: props.hasActiveFilter ? 'primary' : 'secondary',
        size: 'sm',
        onClick: props.onFilterToggle,
        title: 'Edit Filter',
      },
        el(api.components.Icon, { icon: FA.faFilter })
      ),
      el(SortControl, {
        sortField: props.sortField,
        sortDir: props.sortDir,
        onSortFieldChange: props.onSortFieldChange,
        onSortDirToggle: props.onSortDirToggle,
      }),
      el(PerPageSelect, { value: props.perPage, onChange: props.onPerPageChange }),
      el(ColumnConfigDropdown, { visible: props.visibleColumns, onChange: props.onColumnsChange })
    );
  }

  // =========================================================================
  // SceneRow
  // =========================================================================

  function SceneRow(props) {
    var scene = props.scene;
    var selected = props.selected;
    var onToggle = props.onToggle;
    var visibleColumns = props.visibleColumns;
    var includeSet = props.includeSet;
    var excludeSet = props.excludeSet;
    var groupByMembership = props.groupByMembership;

    var show = function (key) { return visibleColumns.indexOf(key) >= 0; };

    var filePath = scene.files && scene.files[0] ? scene.files[0].path : '';
    var duration = scene.files && scene.files[0] ? scene.files[0].duration : 0;

    var cells = [];

    // Checkbox
    cells.push(el('td', { key: 'sel', className: 'select-col' },
      el('label', null,
        el('input', {
          type: 'checkbox',
          checked: selected,
          onChange: function () { onToggle(scene.id); },
        })
      )
    ));

    // Cover
    cells.push(el('td', { key: 'cover', className: 'cover_image-data' },
      el(Link, { to: '/scenes/' + scene.id },
        scene.paths && scene.paths.screenshot
          ? el('img', { className: 'image-thumbnail', src: scene.paths.screenshot, loading: 'lazy' })
          : null
      )
    ));

    // Configurable columns
    if (show('title')) {
      cells.push(el('td', { key: 'title', className: 'title-data' },
        el(Link, { to: '/scenes/' + scene.id }, scene.title || filePath.split('/').pop() || scene.id)
      ));
    }
    if (show('duration')) {
      cells.push(el('td', { key: 'dur', className: 'duration-data' }, formatDuration(duration)));
    }
    if (show('date')) {
      cells.push(el('td', { key: 'date', className: 'date-data' }, formatDate(scene.updated_at)));
    }
    if (show('studio')) {
      cells.push(el('td', { key: 'studio', className: 'studio-data' }, scene.studio ? scene.studio.name : ''));
    }
    if (show('performers')) {
      cells.push(el('td', { key: 'perf', className: 'performers-data' },
        (scene.performers || []).map(function (p) { return p.name; }).join(', ')
      ));
    }
    if (show('rating')) {
      cells.push(el('td', { key: 'rating', className: 'rating-data' }, scene.rating100 ? (scene.rating100 / 20).toFixed(1) : ''));
    }
    if (show('path')) {
      cells.push(el('td', { key: 'path', className: 'path-data' }, filePath));
    }
    if (show('tags')) {
      var tags = scene.tags || [];
      var hasTaxonomy = includeSet.size > 0 || excludeSet.size > 0;
      if (hasTaxonomy && groupByMembership) {
        tags = sortTagsByMembership(tags, includeSet, excludeSet);
      }
      cells.push(el('td', { key: 'tags', className: 'tags-data' },
        tags.map(function (tag) {
          var colorClass = hasTaxonomy ? getTagColorClass(tag.id, includeSet, excludeSet) : '';
          return el('span', {
            key: tag.id,
            className: 'tag-item d-inline-block badge badge-secondary' + (colorClass ? ' ' + colorClass : ''),
          }, tag.name);
        })
      ));
    }

    return el('tr', null, cells);
  }

  // =========================================================================
  // SceneTable
  // =========================================================================

  function SceneTable(props) {
    var scenes = props.scenes;
    var selectedIds = props.selectedIds;
    var onToggle = props.onToggle;
    var onToggleAll = props.onToggleAll;
    var visibleColumns = props.visibleColumns;
    var includeSet = props.includeSet;
    var excludeSet = props.excludeSet;
    var groupByMembership = props.groupByMembership;

    var show = function (key) { return visibleColumns.indexOf(key) >= 0; };
    var allSelected = scenes.length > 0 && scenes.every(function (s) { return selectedIds.has(s.id); });

    var headers = [];
    headers.push(el('th', { key: 'sel', className: 'select-col' },
      el('input', { type: 'checkbox', checked: allSelected, onChange: onToggleAll })
    ));
    headers.push(el('th', { key: 'cover', className: 'cover_image-head' }, 'Cover Image'));
    if (show('title'))      headers.push(el('th', { key: 'title', className: 'title-head' }, 'Title'));
    if (show('duration'))   headers.push(el('th', { key: 'dur', className: 'duration-head' }, 'Duration'));
    if (show('date'))       headers.push(el('th', { key: 'date', className: 'date-head' }, 'Date'));
    if (show('studio'))     headers.push(el('th', { key: 'studio', className: 'studio-head' }, 'Studio'));
    if (show('performers')) headers.push(el('th', { key: 'perf', className: 'performers-head' }, 'Performers'));
    if (show('rating'))     headers.push(el('th', { key: 'rating', className: 'rating-head' }, 'Rating'));
    if (show('path'))       headers.push(el('th', { key: 'path', className: 'path-head' }, 'File Path'));
    if (show('tags'))       headers.push(el('th', { key: 'tags', className: 'tags-head' }, 'Tags'));

    return el(Table, { striped: true, bordered: true, hover: true, className: 'table table-striped table-bordered' },
      el('thead', null, el('tr', null, headers)),
      el('tbody', null,
        scenes.map(function (scene) {
          return el(SceneRow, {
            key: scene.id,
            scene: scene,
            selected: selectedIds.has(scene.id),
            onToggle: onToggle,
            visibleColumns: visibleColumns,
            includeSet: includeSet,
            excludeSet: excludeSet,
            groupByMembership: groupByMembership,
          });
        })
      )
    );
  }

  // =========================================================================
  // TagManagerPageInner — main logic + state
  // =========================================================================

  function TagManagerPageInner() {
    // --- Pagination & sort ---
    var pageState = useState(1);
    var page = pageState[0]; var setPage = pageState[1];

    var perPageLS = useLocalStorage('perPage', 40);
    var perPage = perPageLS[0]; var setPerPage = perPageLS[1];

    var sortFieldLS = useLocalStorage('sortField', 'updated_at');
    var sortField = sortFieldLS[0]; var setSortField = sortFieldLS[1];

    var sortDirLS = useLocalStorage('sortDir', 'DESC');
    var sortDir = sortDirLS[0]; var setSortDir = sortDirLS[1];

    // --- Column config ---
    var defaultCols = ALL_COLUMNS.filter(function (c) { return c.on; }).map(function (c) { return c.key; });
    var colsLS = useLocalStorage('columns', defaultCols);
    var visibleColumns = colsLS[0]; var setVisibleColumns = colsLS[1];

    // --- Selection ---
    var selState = useState(new Set());
    var selectedIds = selState[0]; var setSelectedIds = selState[1];

    // Reset selection on page change
    useEffect(function () { setSelectedIds(new Set()); }, [page, perPage, sortField, sortDir]);

    // --- All tags (for taxonomy + filter controls) ---
    var allTags = useAllTags();

    // --- Taxonomy state (client-side color coding) ---
    var taxIncLS = useLocalStorage('taxIncludeIds', []);
    var taxIncludeIds = taxIncLS[0]; var setTaxIncludeIds = taxIncLS[1];

    var taxExcLS = useLocalStorage('taxExcludeIds', []);
    var taxExcludeIds = taxExcLS[0]; var setTaxExcludeIds = taxExcLS[1];

    var taxSubLS = useLocalStorage('taxIncludeSubTags', false);
    var taxIncludeSubTags = taxSubLS[0]; var setTaxIncludeSubTags = taxSubLS[1];

    var groupLS = useLocalStorage('groupByMembership', false);
    var groupByMembership = groupLS[0]; var setGroupByMembership = groupLS[1];

    // Resolved taxonomy sets (expanded with descendants when recursion is on)
    var resolvedIncludeSet = useResolvedTagSet(taxIncludeIds, taxIncludeSubTags, allTags);
    var resolvedExcludeSet = useResolvedTagSet(taxExcludeIds, taxIncludeSubTags, allTags);

    // --- Edit Filter state ---
    var filterOpenState = useState(false);
    var filterOpen = filterOpenState[0]; var setFilterOpen = filterOpenState[1];

    var filterTagIncState = useState([]);
    var filterTagIncludeIds = filterTagIncState[0]; var setFilterTagIncludeIds = filterTagIncState[1];

    var filterTagExcState = useState([]);
    var filterTagExcludeIds = filterTagExcState[0]; var setFilterTagExcludeIds = filterTagExcState[1];

    var filterTagDepthState = useState(0);
    var filterTagDepth = filterTagDepthState[0]; var setFilterTagDepth = filterTagDepthState[1];

    var filterPathState = useState('');
    var filterPath = filterPathState[0]; var setFilterPath = filterPathState[1];

    var filterPathModState = useState('INCLUDES');
    var filterPathModifier = filterPathModState[0]; var setFilterPathModifier = filterPathModState[1];

    var filterOrgState = useState(null);
    var filterOrganized = filterOrgState[0]; var setFilterOrganized = filterOrgState[1];

    // --- GQL: fetch scenes ---
    var direction = sortDir === 'DESC' ? GQL.SortDirectionEnum.Desc : GQL.SortDirectionEnum.Asc;

    var sceneFilter = useMemo(function () {
      var f = {};
      var hasFilter = false;
      if (filterTagIncludeIds.length > 0) {
        f.tags = { value: filterTagIncludeIds, modifier: GQL.CriterionModifier.IncludesAll, depth: filterTagDepth };
        hasFilter = true;
      }
      if (filterTagExcludeIds.length > 0) {
        if (f.tags) {
          f.AND = { tags: { value: filterTagExcludeIds, modifier: GQL.CriterionModifier.Excludes, depth: filterTagDepth } };
        } else {
          f.tags = { value: filterTagExcludeIds, modifier: GQL.CriterionModifier.Excludes, depth: filterTagDepth };
        }
        hasFilter = true;
      }
      if (filterPath) {
        f.path = { value: filterPath, modifier: GQL.CriterionModifier[filterPathModifier] || GQL.CriterionModifier.Includes };
        hasFilter = true;
      }
      if (filterOrganized !== null) {
        f.organized = filterOrganized;
        hasFilter = true;
      }
      return hasFilter ? f : undefined;
    }, [filterTagIncludeIds, filterTagExcludeIds, filterTagDepth, filterPath, filterPathModifier, filterOrganized]);

    var queryResult = GQL.useFindScenesQuery({
      variables: {
        filter: {
          page: page,
          per_page: perPage,
          sort: sortField,
          direction: direction,
        },
        scene_filter: sceneFilter,
      },
      fetchPolicy: 'cache-and-network',
    });

    var data = queryResult.data;
    var loading = queryResult.loading;

    var scenes = data && data.findScenes ? data.findScenes.scenes : [];
    var totalCount = data && data.findScenes ? data.findScenes.count : 0;
    var totalPages = Math.ceil(totalCount / perPage) || 1;

    // --- Batch mutation ---
    var bulkMutResult = GQL.useBulkSceneUpdateMutation();
    var bulkSceneUpdate = bulkMutResult[0];
    var bulkLoading = bulkMutResult[1] && bulkMutResult[1].loading;

    var pendingActionState = useState(null);
    var pendingAction = pendingActionState[0]; var setPendingAction = pendingActionState[1];

    var toast = api.hooks.useToast();

    // --- Leaf tag detection (tags with no children) ---
    var leafTagIds = useMemo(function () {
      var set = new Set();
      allTags.forEach(function (t) {
        if (!t.children || t.children.length === 0) set.add(t.id);
      });
      return set;
    }, [allTags]);

    // --- Handlers ---
    var handleToggle = useCallback(function (id) {
      setSelectedIds(function (prev) {
        var next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    }, []);

    var handleToggleAll = useCallback(function () {
      setSelectedIds(function (prev) {
        var allSelected = scenes.every(function (s) { return prev.has(s.id); });
        if (allSelected) return new Set();
        var next = new Set();
        scenes.forEach(function (s) { next.add(s.id); });
        return next;
      });
    }, [scenes]);

    var handleSortDirToggle = useCallback(function () {
      setSortDir(function (d) { return d === 'DESC' ? 'ASC' : 'DESC'; });
      setPage(1);
    }, []);

    var handleSortFieldChange = useCallback(function (field) {
      setSortField(field);
      setPage(1);
    }, []);

    var handlePerPageChange = useCallback(function (n) {
      setPerPage(n);
      setPage(1);
    }, []);

    var handlePageChange = useCallback(function (p) {
      setPage(p);
    }, []);

    // Batch actions
    function handleRemoveExcluded() {
      var tagIds = Array.from(resolvedExcludeSet);
      if (tagIds.length === 0) return;
      setPendingAction({ type: 'remove', tagIds: tagIds, sceneIds: Array.from(selectedIds) });
    }

    function handleAddIncluded() {
      var tagIds = Array.from(resolvedIncludeSet).filter(function (id) { return leafTagIds.has(id); });
      if (tagIds.length === 0) return;
      setPendingAction({ type: 'add', tagIds: tagIds, sceneIds: Array.from(selectedIds) });
    }

    function handleConfirmAction() {
      if (!pendingAction) return;
      var mode = pendingAction.type === 'remove' ? GQL.BulkUpdateIdMode.Remove : GQL.BulkUpdateIdMode.Add;
      bulkSceneUpdate({
        variables: {
          input: {
            ids: pendingAction.sceneIds,
            tag_ids: { ids: pendingAction.tagIds, mode: mode },
          },
        },
      }).then(function () {
        toast.toast({ variant: 'success', content: pendingAction.type === 'remove'
          ? 'Removed ' + pendingAction.tagIds.length + ' tags from ' + pendingAction.sceneIds.length + ' scenes'
          : 'Added ' + pendingAction.tagIds.length + ' tags to ' + pendingAction.sceneIds.length + ' scenes'
        });
        setSelectedIds(new Set());
        setPendingAction(null);
        queryResult.refetch();
      }).catch(function (err) {
        toast.toast({ variant: 'danger', content: 'Error: ' + (err.message || err) });
        setPendingAction(null);
      });
    }

    // Tag name lookup for modal display
    var tagNameMap = useMemo(function () {
      var m = {};
      allTags.forEach(function (t) { m[t.id] = t.name; });
      return m;
    }, [allTags]);

    // Active filter indicator
    var hasActiveFilter = sceneFilter != null;

    // --- Render ---
    return el('div', { className: 'tm-page container-fluid' },
      el('h4', { className: 'mb-3' }, 'Tag Manager'),

      el(Toolbar, {
        sortField: sortField,
        sortDir: sortDir,
        onSortFieldChange: handleSortFieldChange,
        onSortDirToggle: handleSortDirToggle,
        perPage: perPage,
        onPerPageChange: handlePerPageChange,
        visibleColumns: visibleColumns,
        onColumnsChange: setVisibleColumns,
        onFilterToggle: function () { setFilterOpen(!filterOpen); },
        hasActiveFilter: hasActiveFilter,
      }),

      // Edit Filter modal
      el(EditFilterModal, {
        show: filterOpen,
        allTags: allTags,
        filterTagIncludeIds: filterTagIncludeIds,
        filterTagExcludeIds: filterTagExcludeIds,
        filterTagDepth: filterTagDepth,
        filterPath: filterPath,
        filterPathModifier: filterPathModifier,
        filterOrganized: filterOrganized,
        onFilterTagIncludeChange: setFilterTagIncludeIds,
        onFilterTagExcludeChange: setFilterTagExcludeIds,
        onFilterTagDepthChange: setFilterTagDepth,
        onFilterPathChange: setFilterPath,
        onFilterPathModifierChange: setFilterPathModifier,
        onFilterOrganizedChange: setFilterOrganized,
        onClose: function () { setFilterOpen(false); },
      }),

      el(PaginationNav, {
        currentPage: page,
        totalPages: totalPages,
        onPageChange: handlePageChange,
        totalItems: totalCount,
        perPage: perPage,
      }),

      // Taxonomy control
      el(TaxonomyControl, {
        allTags: allTags,
        taxIncludeIds: taxIncludeIds,
        taxExcludeIds: taxExcludeIds,
        onIncludeChange: setTaxIncludeIds,
        onExcludeChange: setTaxExcludeIds,
        includeSubTags: taxIncludeSubTags,
        onIncludeSubTagsChange: setTaxIncludeSubTags,
        groupByMembership: groupByMembership,
        onGroupByMembershipChange: setGroupByMembership,
      }),

      // Batch action bar
      selectedIds.size > 0 && el('div', { className: 'tm-batch-bar' },
        el('span', { className: 'tm-batch-count' }, selectedIds.size + ' selected'),
        el(Button, {
          variant: 'outline-danger',
          size: 'sm',
          disabled: resolvedExcludeSet.size === 0 || bulkLoading,
          onClick: handleRemoveExcluded,
        }, 'Remove excluded tags'),
        el(Button, {
          variant: 'outline-success',
          size: 'sm',
          disabled: resolvedIncludeSet.size === 0 || bulkLoading,
          onClick: handleAddIncluded,
        }, 'Add included tags')
      ),

      loading && !data
        ? el('div', { className: 'text-center py-4' }, el(Spinner, { animation: 'border' }))
        : scenes.length === 0
          ? el('div', { className: 'text-center text-muted py-5' },
              el('h5', null, 'No scenes found'),
              hasActiveFilter && el('p', null, 'Try adjusting your filter criteria.')
            )
          : el('div', { className: 'table-list scene-table' },
              el(SceneTable, {
                scenes: scenes,
                selectedIds: selectedIds,
                onToggle: handleToggle,
                onToggleAll: handleToggleAll,
                visibleColumns: visibleColumns,
                includeSet: resolvedIncludeSet,
                excludeSet: resolvedExcludeSet,
                groupByMembership: groupByMembership,
              })
            ),

      el(PaginationNav, {
        currentPage: page,
        totalPages: totalPages,
        onPageChange: handlePageChange,
      }),

      // Confirmation modal
      pendingAction && el(Modal, {
        show: true,
        onHide: function () { setPendingAction(null); },
        centered: true,
      },
        el(Modal.Header, { closeButton: true },
          el(Modal.Title, null, pendingAction.type === 'remove' ? 'Remove Excluded Tags' : 'Add Included Tags')
        ),
        el(Modal.Body, null,
          el('p', null,
            pendingAction.type === 'remove'
              ? 'Remove ' + pendingAction.tagIds.length + ' excluded tags from ' + pendingAction.sceneIds.length + ' selected scenes?'
              : 'Add ' + pendingAction.tagIds.length + ' included (leaf) tags to ' + pendingAction.sceneIds.length + ' selected scenes?'
          ),
          el('div', { className: 'tm-taxonomy-pills' },
            pendingAction.tagIds.map(function (id) {
              return el(Badge, {
                key: id,
                className: pendingAction.type === 'remove' ? 'tm-tag-excluded' : 'tm-tag-included',
              }, tagNameMap[id] || id);
            })
          )
        ),
        el(Modal.Footer, null,
          el(Button, { variant: 'secondary', onClick: function () { setPendingAction(null); } }, 'Cancel'),
          el(Button, {
            variant: pendingAction.type === 'remove' ? 'danger' : 'success',
            onClick: handleConfirmAction,
            disabled: bulkLoading,
          }, bulkLoading ? el(Spinner, { animation: 'border', size: 'sm' }) : 'Confirm')
        )
      )
    );
  }

  // =========================================================================
  // TagManagerPage — loadable gate
  // =========================================================================

  function TagManagerPage() {
    var componentsLoading = api.hooks.useLoadComponents([
      api.loadableComponents.SceneCard,
      api.loadableComponents.Tags,
    ]);

    if (componentsLoading) {
      return el('div', { className: 'text-center py-5' },
        el(api.components.LoadingIndicator, null)
      );
    }

    return el(TagManagerPageInner, null);
  }

  // =========================================================================
  // Registration
  // =========================================================================

  api.register.route(ROUTE_PATH, TagManagerPage);

  api.patch.before('MainNavBar.UtilityItems', function (props) {
    var Icon = api.components.Icon;
    return [{
      children: el(React.Fragment, null,
        props.children,
        el(NavLink, {
          className: 'nav-utility',
          exact: true,
          to: ROUTE_PATH,
        },
          el(Button, {
            className: 'minimal d-flex align-items-center h-100',
            title: 'Tag Manager',
          },
            el(Icon, { icon: FA.faTags })
          )
        )
      ),
    }];
  });

})();
