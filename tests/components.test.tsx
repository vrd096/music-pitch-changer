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
  it('should render with correct initial value', () => {
    const onChange = vi.fn();

    render(<SpeedSlider value={1.0} onChange={onChange} disabled={false} />);

    const slider = screen.getByRole('slider');
    expect(slider).toBeInTheDocument();
    expect(slider).not.toBeDisabled();
  });

  it('should be disabled when disabled prop is true', () => {
    const onChange = vi.fn();

    render(<SpeedSlider value={1.0} onChange={onChange} disabled={true} />);

    expect(screen.getByRole('slider')).toBeDisabled();
  });
});

describe('PitchSlider', () => {
  it('should render with correct initial value', () => {
    const onChange = vi.fn();

    render(<PitchSlider value={0} onChange={onChange} disabled={false} />);

    const slider = screen.getByRole('slider');
    expect(slider).toBeInTheDocument();
    expect(slider).not.toBeDisabled();
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
