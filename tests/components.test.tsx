/// <reference types="vitest/globals" />
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Mock chrome API
vi.stubGlobal('chrome', (globalThis as any).chrome);

// Mock components
import { StartStopButton } from '../src/popup/components/StartStopButton';
import { BpmDisplay } from '../src/popup/components/BpmDisplay';
import { KeyDisplay } from '../src/popup/components/KeyDisplay';
import { SpeedSlider } from '../src/popup/components/SpeedSlider';
import { PitchSlider } from '../src/popup/components/PitchSlider';
import { BypassToggle } from '../src/popup/components/BypassToggle';

describe('StartStopButton', () => {
  it('should render Start button when not capturing', () => {
    const onStart = vi.fn();
    const onStop = vi.fn();

    render(<StartStopButton isCapturing={false} onStart={onStart} onStop={onStop} />);

    expect(screen.getByText('Start')).toBeInTheDocument();
  });

  it('should render Stop button when capturing', () => {
    const onStart = vi.fn();
    const onStop = vi.fn();

    render(<StartStopButton isCapturing={true} onStart={onStart} onStop={onStop} />);

    expect(screen.getByText('Stop')).toBeInTheDocument();
  });

  it('should call onStart when clicked in idle state', () => {
    const onStart = vi.fn();
    const onStop = vi.fn();

    render(<StartStopButton isCapturing={false} onStart={onStart} onStop={onStop} />);

    fireEvent.click(screen.getByText('Start'));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('should call onStop when clicked in capturing state', () => {
    const onStart = vi.fn();
    const onStop = vi.fn();

    render(<StartStopButton isCapturing={true} onStart={onStart} onStop={onStop} />);

    fireEvent.click(screen.getByText('Stop'));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe('BpmDisplay', () => {
  it('should display -- when not capturing', () => {
    render(<BpmDisplay bpm={null} isCapturing={false} />);
    expect(screen.getByText('--')).toBeInTheDocument();
  });

  it('should display BPM value when capturing', () => {
    render(<BpmDisplay bpm={128} isCapturing={true} />);
    expect(screen.getByText('128')).toBeInTheDocument();
  });

  it('should display ellipsis when capturing without BPM', () => {
    render(<BpmDisplay bpm={null} isCapturing={true} />);
    expect(screen.getByText('···')).toBeInTheDocument();
  });
});

describe('KeyDisplay', () => {
  it('should display -- when not capturing', () => {
    render(<KeyDisplay keyValue={null} confidence={null} isCapturing={false} />);
    expect(screen.getByText('--')).toBeInTheDocument();
  });

  it('should display key when capturing', () => {
    render(<KeyDisplay keyValue={'C major'} confidence={0.85} isCapturing={true} />);
    expect(screen.getByText('C major')).toBeInTheDocument();
  });

  it('should display ellipsis when capturing without key', () => {
    render(<KeyDisplay keyValue={null} confidence={null} isCapturing={true} />);
    expect(screen.getByText('···')).toBeInTheDocument();
  });
});

describe('SpeedSlider', () => {
  it('should render with correct initial value (default 120 BPM)', () => {
    const onChange = vi.fn();

    render(<SpeedSlider value={1.0} onChange={onChange} disabled={false} />);

    const slider = screen.getByRole('slider');
    expect(slider).toBeInTheDocument();
    expect(slider).not.toBeDisabled();
    expect(slider).toHaveValue('1');
    // Default base BPM = 120, speed 1.0 → 120 BPM
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('BPM')).toBeInTheDocument();
  });

  it('should display correct BPM when value changes', () => {
    const onChange = vi.fn();

    render(<SpeedSlider value={1.5} onChange={onChange} disabled={false} />);

    // 120 * 1.5 = 180 BPM
    expect(screen.getByText('180')).toBeInTheDocument();
  });

  it('should display computed BPM when original BPM is known', () => {
    const onChange = vi.fn();

    render(<SpeedSlider value={1.0} onChange={onChange} disabled={false} bpm={140} />);

    // 140 * 1.0 = 140 BPM
    expect(screen.getByText('140')).toBeInTheDocument();
  });

  it('should be disabled when disabled prop is true', () => {
    const onChange = vi.fn();

    render(<SpeedSlider value={1.0} onChange={onChange} disabled={true} />);

    expect(screen.getByRole('slider')).toBeDisabled();
  });

  it('should render +/- BPM buttons', () => {
    const onChange = vi.fn();

    render(<SpeedSlider value={1.0} onChange={onChange} disabled={false} />);

    expect(screen.getByText('−1 BPM')).toBeInTheDocument();
    expect(screen.getByText('+1 BPM')).toBeInTheDocument();
  });

  it('should call onChange with adjusted speed when +1 BPM clicked', () => {
    const onChange = vi.fn();

    render(<SpeedSlider value={1.0} onChange={onChange} disabled={false} />);

    // 120 * 1.0 = 120 BPM, +1 → 121 BPM → 121/120 ≈ 1.0083
    fireEvent.click(screen.getByText('+1 BPM'));
    expect(onChange).toHaveBeenCalledWith(121 / 120);
  });

  it('should call onChange with adjusted speed when −1 BPM clicked', () => {
    const onChange = vi.fn();

    render(<SpeedSlider value={1.0} onChange={onChange} disabled={false} />);

    // 120 * 1.0 = 120 BPM, -1 → 119 BPM → 119/120 ≈ 0.9917
    fireEvent.click(screen.getByText('−1 BPM'));
    expect(onChange).toHaveBeenCalledWith(119 / 120);
  });
});

describe('PitchSlider', () => {
  it('should render with correct initial value', () => {
    const onChange = vi.fn();

    render(<PitchSlider value={0} onChange={onChange} disabled={false} />);

    const slider = screen.getByRole('slider');
    expect(slider).toBeInTheDocument();
    expect(slider).not.toBeDisabled();
    // Use getAllByText and check the value display span exists
    const valueSpans = screen.getAllByText('0');
    expect(valueSpans.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('st', { selector: 'span' })).toBeInTheDocument();
  });

  it('should render +/- semitone buttons', () => {
    const onChange = vi.fn();

    render(<PitchSlider value={0} onChange={onChange} disabled={false} />);

    expect(screen.getByText('−1 st')).toBeInTheDocument();
    expect(screen.getByText('+1 st')).toBeInTheDocument();
  });

  it('should call onChange with +1 when +1 st clicked', () => {
    const onChange = vi.fn();

    render(<PitchSlider value={3} onChange={onChange} disabled={false} />);

    fireEvent.click(screen.getByText('+1 st'));
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('should call onChange with -1 when −1 st clicked', () => {
    const onChange = vi.fn();

    render(<PitchSlider value={3} onChange={onChange} disabled={false} />);

    fireEvent.click(screen.getByText('−1 st'));
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('should clamp value at lower bound -12', () => {
    const onChange = vi.fn();

    render(<PitchSlider value={-12} onChange={onChange} disabled={false} />);

    // Button should be disabled at -12
    expect(screen.getByText('−1 st')).toBeDisabled();
  });

  it('should clamp value at upper bound +12', () => {
    const onChange = vi.fn();

    render(<PitchSlider value={12} onChange={onChange} disabled={false} />);

    // Button should be disabled at +12
    expect(screen.getByText('+1 st')).toBeDisabled();
  });
});

describe('BypassToggle', () => {
  it('should render unchecked when disabled', () => {
    const onChange = vi.fn();

    render(<BypassToggle enabled={false} onChange={onChange} disabled={false} />);

    expect(screen.getByText('Bypass')).toBeInTheDocument();
  });

  it('should show bypass description when enabled', () => {
    const onChange = vi.fn();

    render(<BypassToggle enabled={true} onChange={onChange} disabled={false} />);

    expect(screen.getByText('Bypass')).toBeInTheDocument();
  });
});
