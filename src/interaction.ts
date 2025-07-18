/* eslint-disable no-underscore-dangle */
/* eslint-disable @typescript-eslint/unbound-method */

import { BaseType, select } from 'd3-selection';
import { timer } from 'd3-timer';
import { D3ZoomEvent, zoom, zoomIdentity } from 'd3-zoom';
import { mean } from 'd3-array';
import { ScaleLinear, scaleLinear } from 'd3-scale';
// import { annotation, annotationLabel } from 'd3-svg-annotation';
import type { Renderer } from './rendering';
import { ReglRenderer } from './regl_rendering';
import { StructRowProxy } from 'apache-arrow';
import { Rectangle } from './tile';
import type { Deeptable } from './Deeptable';
import type * as DS from './types';
import type { Scatterplot } from './scatterplot';
import { PositionalAesthetic } from './aesthetics/ScaledAesthetic';
import { Qid } from './tixrixqid';
import { isConstantChannel, isLambdaChannel } from './typing';
type Annotation = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  data: StructRowProxy;
  qid: Qid;
  pointSize: number;
};

// A collection of zoomed and unzoomed scales returned by the interaction component.
export type ScaleSet = {
  // The x scale to the screen coordinates at no zoom.
  x: ScaleLinear<number, number>;
  // The y scale to the screen coordinates at no zoom.
  y: ScaleLinear<number, number>;
  // The x scale in the translated space of the current zoom.
  x_: ScaleLinear<number, number>;
  // The y scale in the translated space of the current zoom.
  y_: ScaleLinear<number, number>;
};

export class Zoom {
  public prefs: DS.APICall;
  public svg_element_selection: d3.Selection<
    d3.ContainerElement,
    Record<string, BaseType>,
    HTMLElement,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >;
  public width: number;
  public height: number;
  public renderers: Map<string, Renderer>;
  public deeptable?: Deeptable;
  public _timer?: d3.Timer;
  public _scales?: ScaleSet;
  public zoomer?: d3.ZoomBehavior<Element, unknown>;
  public transform?: d3.ZoomTransform;
  public _start?: number;
  public scatterplot: Scatterplot;
  private stopTimerAt?: number;
  constructor(selector: string, prefs: DS.APICall, plot: Scatterplot) {
    // There can be many canvases that display the zoom, but
    // this is initialized with the topmost most one that
    // also registers events.

    this.prefs = prefs;

    this.svg_element_selection = select(selector);
    this.width = +this.svg_element_selection.attr('width');
    this.height = +this.svg_element_selection.attr('height');
    this.renderers = new Map();
    this.scatterplot = plot;
    // A zoom keeps track of all the renderers
    // that it's in charge of adjusting.

    this.renderers = new Map();
  }

  attach_tiles(tiles: Deeptable) {
    this.deeptable = tiles;
    return this;
  }

  attach_renderer(key: string, renderer: Renderer) {
    this.renderers.set(key, renderer);
    renderer.bind_zoom(this);
    renderer.zoom.initialize_zoom();
    return this;
  }

  zoom_to(k: number, x: number, y: number, duration = 4000) {
    const scales = this.scales();
    const { svg_element_selection: canvas, zoomer, width, height } = this;

    const t = zoomIdentity
      .translate(width / 2, height / 2)
      .scale(k)
      .translate(-scales.x(x), -scales.y(y));
    canvas.transition().duration(duration).call(zoomer.transform, t);
  }

  html_annotation(points: Annotation[]) {
    const div = this.svg_element_selection.node().parentNode
      .parentNode as HTMLDivElement;
    const els = select(div)
      .selectAll('div.tooltip')
      .data(points)
      .join(
        (enter) =>
          enter
            .append('div')
            .attr('class', 'tooltip')
            .style('top', 0)
            .style('left', 0)
            .style('position', 'absolute')
            .style('z-index', 100)
            .style('border-radius', '8px')
            .style('padding', '10px')
            .style('background', 'ivory'),
        (update) =>
          update.html((d) =>
            this.scatterplot.tooltip_handler.f(d.qid, this.scatterplot),
          ),
        (exit) => exit.call((e) => e.remove()),
      );

    els
      .html((d) => this.scatterplot.tooltip_handler.f(d.qid, this.scatterplot))
      .style('transform', (d) => {
        const t = `translate(${+d.x + d.dx}px, ${+d.y + d.dy}px)`;
        return t;
      });
  }

  zoom_to_bbox(corners: Rectangle, duration = 4000, buffer = 1.111) {
    // Zooms to two points.
    const scales = this.scales();
    // eslint-disable-next-line prefer-const
    let [x0, x1] = corners.x.map(scales.x);
    const [y0, y1] = corners.y.map(scales.y);

    if (this.scatterplot.prefs.zoom_align === 'right') {
      const aspect_ratio = this.width / this.height;
      const data_aspect_ratio = (x1 - x0) / (y1 - y0);
      if (data_aspect_ratio < aspect_ratio) {
        const extension = data_aspect_ratio / aspect_ratio;
        x0 = x0 - (x1 - x0) * extension;
      }
    }
    const { svg_element_selection: canvas, zoomer, width, height } = this;

    const t = zoomIdentity
      .translate(width / 2, height / 2)
      .scale(1 / buffer / Math.max((x1 - x0) / width, (y1 - y0) / height))
      .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);

    canvas.transition().duration(duration).call(zoomer.transform, t);
  }

  initialize_zoom() {
    const { width, height, svg_element_selection: canvas } = this;
    this.transform = zoomIdentity;

    const zoomer = zoom()
      .scaleExtent([1 / 3, 100_000])
      .extent([
        [0, 0],
        [width, height],
      ])
      .on('zoom', (event: D3ZoomEvent<Element, unknown>) => {
        document.getElementById('tooltipcircle')?.remove();
        this.transform = event.transform;
        this.restart_timer(10 * 1000);

        this.scatterplot.on_zoom?.(event.transform);
        if (event.sourceEvent) {
          (event.sourceEvent as Event).stopPropagation();
        }
      })

    canvas.call(zoomer);

    this.add_mouseover();

    this.zoomer = zoomer;
  }

  set_highlit_points(dd: Qid[]) {
    const { x_, y_ } = this.scales();
    const xdim = this.scatterplot.dim('x') as PositionalAesthetic;
    const ydim = this.scatterplot.dim('y') as PositionalAesthetic;

    const data = this.scatterplot.deeptable.getQids(dd)
    this.scatterplot.highlit_point_change(dd, this.scatterplot);

    // Calculate zoom adjustment for point size
    const k = this.transform?.k || 1;
    const zoom_balance = this.scatterplot.prefs.zoom_balance || 0.66;
    const point_size_adjust = Math.exp(Math.log(k) * zoom_balance);

    // Get base point size from preferences
    const base_size = this.scatterplot.prefs.point_size || 1;

    const annotations: Annotation[] = data.map((d, i) => {
      // Get size multiplier from size aesthetic if available
      let size_multiplier = 1.5; // default value

      const size = this.scatterplot.prefs.encoding.size;

      if (isConstantChannel(size)) {
        size_multiplier *= size.constant;
      } else if (isLambdaChannel(size)) {
        size_multiplier *= Math.sqrt(Number(d[size.field]));
      }

      // Calculate actual point size used in rendering
      const actual_point_size = point_size_adjust * base_size * size_multiplier;

      return {
        x: x_(xdim.apply(d)),
        y: y_(ydim.apply(d)),
        data: d,
        dx: 0,
        dy: 30,
        qid: dd[i],
        pointSize: actual_point_size,
      };
    });
    this.html_annotation(annotations);

    const sel = this.svg_element_selection.select('#mousepoints');
    sel
      .selectAll('circle.label')
      .data(annotations, (d_: Annotation) => d_.data.ix as number) // Unique identifier to not remove existing.
      .join(
        (enter) =>
          enter
            .append('circle')
            .attr('id', 'tooltipcircle')
            .attr('class', 'label')
            .attr('stroke', '#110022')
            .attr('r', (d) => d.pointSize)
            .attr('fill', (d) => this.scatterplot.dim('color').apply(d.data))
            .attr('cx', (d) => x_(xdim.apply(d.data)))
            .attr('cy', (d) => y_(ydim.apply(d.data))),

        (update) =>
          update
            .attr('fill', (d) => this.scatterplot.dim('color').apply(d.data))
            .attr('r', (d) => d.pointSize),

        (exit) =>
          exit.call((e) => {
            e.remove();
          }),
      )
      .on('click', (ev, dd) => {
        this.scatterplot.click_handler.f(dd.qid, this.scatterplot);
      });
  }

  add_mouseover() {
    let last_fired = 0;
    const renderer: ReglRenderer = this.renderers.get('regl') as ReglRenderer;

    this.svg_element_selection.on('mousemove', (event: MouseEvent) => {
      // Debouncing this is really important, it turns out.
      if (Date.now() - last_fired < 75) {
        return;
      }
      last_fired = Date.now();
      const p = renderer.color_pick(event.offsetX, event.offsetY);
      if (p === null) {
        this.set_highlit_points([]);
      } else {
        this.set_highlit_points([p]);
      }
    });
  }

  current_corners(): Rectangle {
    // The corners of the current zoom transform, in data coordinates.
    const { width, height } = this;

    // Use the rescaled versions of the scales.
    const scales = this.scales();
    if (scales === undefined) {
      throw new Error(
        'Attempting to get map view before scales have been created',
      );
    }
    const { x_, y_ } = scales;

    return {
      x: [x_.invert(0), x_.invert(width)],
      y: [y_.invert(0), y_.invert(height)],
    };
  }

  current_center() {
    const { x, y } = this.current_corners();
    return [(x[0] + x[1]) / 2, (y[0] + y[1]) / 2];
  }

  restart_timer(run_at_least = 10_000) {
    // Restart the timer and run it for
    // run_at_least milliseconds or the current timeout,
    // whichever is greater.
    let stop_at = Date.now() + run_at_least;
    if (this._timer) {
      if (this.stopTimerAt > stop_at) {
        stop_at = this.stopTimerAt;
      }
      this._timer.stop();
    }

    const t = timer(this.tick.bind(this));

    this._timer = t;
    this.stopTimerAt = stop_at;
    return this._timer;
  }

  data(deeptable: undefined): Deeptable;
  data(deeptable: Deeptable): Zoom;

  data(deeptable: Deeptable | undefined) {
    if (deeptable === undefined) {
      return this.deeptable;
    }
    this.deeptable = deeptable;
    return this as Zoom;
  }

  /**
   *
   * @returns
   */
  scales(): ScaleSet {
    // General x and y scales that map from data space
    // to pixel coordinates, and also
    // rescaled ones that describe the current zoom.
    // The base scales are called 'x' and 'y',
    // and the zoomed ones are called 'x_' and 'y_'.

    // equal_units: should a point of x be the same as a point of y?

    if (this._scales) {
      this._scales.x_ = this.transform.rescaleX(this._scales.x);
      this._scales.y_ = this.transform.rescaleY(this._scales.y);
      return this._scales;
    }

    const { width, height } = this;
    if (this.deeptable === undefined) {
      throw new Error('Error--scales created before tileSet present.');
    }
    const { extent } = this.deeptable;
    if (extent === undefined) {
      throw new Error('Error--scales created before extent present.');
    }

    interface Scale_datum {
      limits: [number, number];
      size_range: number;
      pixels_per_unit: number;
    }
    const scale_dat: Record<string, Scale_datum> = {};
    for (const [name, dim] of [
      ['x', width],
      ['y', height],
    ] as const) {
      const limits = extent[name] as [number, number];
      const size_range = limits[1] - limits[0];
      scale_dat[name] = {
        limits,
        size_range,
        pixels_per_unit: dim / size_range,
      };
    }

    const data_aspect_ratio =
      scale_dat.x.pixels_per_unit / scale_dat.y.pixels_per_unit;

    let x_buffer_size = 0;
    let y_buffer_size = 0;
    let x_target_size = width;
    let y_target_size = height;
    if (data_aspect_ratio > 1) {
      // There are more pixels in the x dimension, so we need a buffer
      // around it.
      x_target_size = width / data_aspect_ratio;
      x_buffer_size = (width - x_target_size) / 2;
    } else {
      y_target_size = height * data_aspect_ratio;
      y_buffer_size = (height - y_target_size) / 2;
    }

    const x = scaleLinear()
      .domain(scale_dat.x.limits)
      .range([x_buffer_size, width - x_buffer_size]);

    const y = scaleLinear()
      .domain(scale_dat.y.limits)
      .range([y_buffer_size, height - y_buffer_size]);

    const scales: ScaleSet = {
      x,
      y,
      x_: this.transform.rescaleX(x),
      y_: this.transform.rescaleY(y),
    };
    this._scales = scales;
    return scales;
  }

  webgl_scale(flatten = true) {
    const { x, y } = this.scales();
    const transform = window_transform(x, y).flat();
    return transform;
  }

  tick(force = false) {
    this._start = this._start || Date.now();

    // Force indicates that the tick must run even the timer metadata
    // says we are not animating.

    if (force !== true && this._timer && this.stopTimerAt <= Date.now()) {
      this._timer.stop();
    }
  }
}

export function window_transform(
  x_scale: ScaleLinear<number, number, never>,
  y_scale: ScaleLinear<number, number, never>,
) {
  // width and height are svg parameters; x and y scales project from the data x and y into the
  // the webgl space.

  // Given two d3 scales in coordinate space, create two matrices that project from the original
  // space into [-1, 1] webgl space.

  function gap(array: number[]) {
    // Return the magnitude of a scale.
    return array[1] - array[0];
  }

  const x_mid = mean(x_scale.domain());
  const y_mid = mean(y_scale.domain());

  const xmulti = gap(x_scale.range()) / gap(x_scale.domain());
  const ymulti = gap(y_scale.range()) / gap(y_scale.domain());

  // translates from data space to scaled space.
  const m1 = [
    // transform by the scale;
    [xmulti, 0, -xmulti * x_mid + mean(x_scale.range())],
    [0, ymulti, -ymulti * y_mid + mean(y_scale.range())],
    [0, 0, 1],
  ];
  // Note--at the end, you need to multiply by this matrix.
  // I calculate it directly on the GPU.
  // translate from scaled space to webgl space.
  // The '2' here is because webgl space runs from -1 to 1.
  /* const m2 = [
    [2 / width, 0, -1],
    [0, - 2 / height, 1],
    [0, 0, 1]
  ] */

  return m1;
}
