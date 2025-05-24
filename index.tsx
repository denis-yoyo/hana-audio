/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

interface AppMetadata {
  prompt?: string;
}

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() systemPrompt: string | null = null;

  private client!: GoogleGenAI;
  private session!: Session;
  // Fix: Use standard AudioContext instead of webkitAudioContext
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  // Fix: Use standard AudioContext instead of webkitAudioContext
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream!: MediaStream;
  private sourceNode!: MediaStreamAudioSourceNode;
  private scriptProcessorNode!: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: white; /* Ensure status text is visible */
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;
        display: flex; /* Added for centering icon */
        align-items: center; /* Added for centering icon */
        justify-content: center; /* Added for centering icon */

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        display: none;
      }
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private async loadSystemPrompt(): Promise<void> {
    try {
      const response = await fetch('metadata.json');
      if (!response.ok) {
        throw new Error(`Failed to fetch metadata.json: ${response.statusText}`);
      }
      const metadata: AppMetadata = await response.json();
      if (metadata.prompt) {
        this.systemPrompt = metadata.prompt;
        this.updateStatus('System prompt loaded.');
      } else {
        this.updateError('System prompt not found in metadata.json.');
      }
    } catch (e: unknown) {
      console.error('Error loading system prompt:', e);
      this.updateError(`Error loading system prompt: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();
    await this.loadSystemPrompt(); // Load prompt before initializing session

    // Check if API key is available
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      this.updateError('API key is missing. Please set the API_KEY environment variable.');
      return; // Exit early if API key is missing
    }

    // Initialize GoogleGenAI with named apiKey parameter
    this.client = new GoogleGenAI({
      apiKey: apiKey,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private async initSession() {
    if (!this.systemPrompt) {
      this.updateError('Cannot initialize session: System prompt not loaded.');
      return;
    }

    const model = 'gemini-2.5-flash-preview-native-audio-dialog'; // Model for live interaction

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Connection Opened. Ready to chat!');
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio =
              message.serverContent?.modelTurn?.parts?.[0]?.inlineData;

            if (audio) {
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000, // Sample rate for output
                1,     // Number of channels
              );
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () =>{
                this.sources.delete(source);
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            const interrupted = message.serverContent?.interrupted;
            if(interrupted) {
              for(const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            this.updateError(`Connection Error: ${e.message}`);
          },
          onclose: (e: CloseEvent) => {
            this.updateStatus(`Connection Closed: ${e.reason || 'No reason provided'}`);
          },
        },
        config: {
          systemInstruction: this.systemPrompt, // Use the loaded system prompt
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Aoede'}}, // Corrected to female voice
            languageCode: 'en-US' // Example language code
          },
        },
      });
    } catch (e: unknown) {
      console.error('Failed to initialize session:', e);
      this.updateError(`Failed to initialize session: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = ''; // Clear previous errors when a new status is set
  }

  private updateError(msg: string) {
    this.error = msg;
    this.status = ''; // Clear status when an error occurs
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    // Ensure session is initialized
    if (!this.session) {
        this.updateError('Session not initialized. Please reset.');
        // Attempt to re-initialize if needed, or guide user.
        if (!this.systemPrompt) await this.loadSystemPrompt();
        if (this.systemPrompt) await this.initSession(); // Try to init session again
        if (!this.session) return; // Still no session, exit
    }


    this.inputAudioContext.resume();
    this.outputAudioContext.resume(); // Ensure output context is also resumed

    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      // Increased buffer size for potentially smoother capture, though 256 is often fine.
      const bufferSize = 1024; 
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1, // input channels
        1, // output channels
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording || !this.session) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0); // Assuming mono input

        try {
            this.session.sendRealtimeInput({media: createBlob(pcmData)});
        } catch(e) {
            console.error("Error sending realtime input:", e);
            this.updateError("Error sending audio data. Session might be closed.");
            this.stopRecording(); // Stop if sending fails critically
        }
      };

      this.inputNode.connect(this.scriptProcessorNode); // Connect GainNode to ScriptProcessor
      this.scriptProcessorNode.connect(this.inputAudioContext.destination); // Essential for onaudioprocess to fire in some browsers

      this.isRecording = true;
      this.updateStatus('🔴 Recording... Talk to Hana!');
    } catch (err: unknown) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error starting recording: ${err instanceof Error ? err.message : String(err)}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext) {
      this.updateStatus('Already stopped or not initialized.');
      return;
    }
    
    this.updateStatus('Stopping recording...');
    this.isRecording = false;

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.onaudioprocess = null; // Remove callback
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode = undefined as unknown as ScriptProcessorNode;
    }
    
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = undefined as unknown as MediaStreamAudioSourceNode;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = undefined as unknown as MediaStream;
    }
    
    // It's good practice to suspend the audio context when not in use
    // if (this.inputAudioContext.state === 'running') {
    //   this.inputAudioContext.suspend();
    // }

    this.updateStatus('Recording stopped. Click Start to chat again.');
  }

  private async reset() {
    this.stopRecording(); // Ensure recording is stopped before reset
    
    for(const source of this.sources.values()) {
        source.stop();
        this.sources.delete(source);
    }
    this.nextStartTime = 0;
    if (this.outputAudioContext.state === 'suspended') {
      await this.outputAudioContext.resume();
    }

    if (this.session) {
      this.session.close();
      // this.session = null; // Clear the session object
    }
    
    this.updateStatus('Resetting session...');
    // Re-initialize session (will also re-fetch prompt if it wasn't loaded)
    if (!this.systemPrompt) await this.loadSystemPrompt();
    await this.initSession(); 
    if(this.session) {
        this.updateStatus('Session reset. Ready for a new chat!');
    } else {
        this.updateError('Failed to reset session. Check console.');
    }
  }

  render() {
    return html`
      <div>
        <div class="controls">
          <button
            id="resetButton"
            @click=${this.reset}
            title="Reset Session"
            aria-label="Reset Session"
            ?disabled=${this.isRecording}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            title="Start Recording"
            aria-label="Start Recording"
            ?disabled=${this.isRecording}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path d="M480-400q-50 0-85-35t-35-85v-240q0-50 35-85t85-35q50 0 85 35t35 85v240q0 50-35 85t-85 35Zm0-80q17 0 28.5-11.5T520-520v-240q0-17-11.5-28.5T480-800q-17 0-28.5 11.5T440-760v240q0 17 11.5 28.5T480-480Zm0 280q83 0 141.5-58.5T680-400h40q0 100-57.5 175T520-160v120h-80v-120q-105-25-162.5-100T220-400h40q0 83 58.5 141.5T480-200Z"/>
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            title="Stop Recording"
            aria-label="Stop Recording"
            ?disabled=${!this.isRecording}>
            <svg
              viewBox="0 0 100 100" 
              width="40px"
              height="40px"
              fill="#ffffff"
              xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
        </div>

        <div id="status" aria-live="polite">
         ${this.error ? `Error: ${this.error}` : this.status}
        </div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
