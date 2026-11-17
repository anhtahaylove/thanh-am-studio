; void vcomp_call(void *fn, int nargs, void **argv)
; Calls fn(argv[0], ..., argv[nargs-1]) with the Win64 convention. The first four slots are loaded
; into both the integer and the XMM argument registers, so integer and floating parameters both work.
; Assembly because C cannot call a function with an argument count known only at run time.
.code
vcomp_call PROC FRAME
    push rbp
    .pushreg rbp
    push rsi
    .pushreg rsi
    push rdi
    .pushreg rdi
    mov rbp, rsp
    .setframe rbp, 0
    .endprolog
    mov r10, rcx            ; fn
    mov rsi, r8             ; argv
    movsxd rcx, edx         ; nargs
    mov rax, rcx
    cmp rax, 4
    jge have_size
    mov rax, 4              ; always reserve the 32-byte home area
have_size:
    lea rax, [rax*8+15]
    and rax, -16
    sub rsp, rax
    mov rdi, rsp
    rep movsq               ; copy nargs slots to the outgoing argument area
    mov rcx, [rsp]
    mov rdx, [rsp+8]
    mov r8,  [rsp+16]
    mov r9,  [rsp+24]
    movq xmm0, rcx
    movq xmm1, rdx
    movq xmm2, r8
    movq xmm3, r9
    call r10
    mov rsp, rbp
    pop rdi
    pop rsi
    pop rbp
    ret
vcomp_call ENDP
END
