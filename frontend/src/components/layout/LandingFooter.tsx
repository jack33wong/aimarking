import React from 'react';
import { Link } from 'react-router-dom';
import { getSupportMailto } from '../../config/support';
import './LandingFooter.css';

export const LandingFooter: React.FC = () => {
    return (
        <footer className="landing-footer-main">
            <div className="footer-container horizontal">
                <div className="footer-brand-side">
                    <span className="footer-logo">AI Marking</span>
                    <span className="footer-copyright">© 2026 AI Marking • Trusted by 15,000+ UK students.</span>
                </div>

                <div className="footer-nav-columns">
                    <div className="footer-column">
                        <span className="footer-label">Product</span>
                        <Link to="/pricing" className="footer-link">Pricing & Plans</Link>
                        <Link to="/features" className="footer-link">Advanced Features</Link>
                        <Link to="/accuracy" className="footer-link">Marking Accuracy</Link>
                    </div>

                    <div className="footer-column">
                        <span className="footer-label">UK Exams</span>
                        <Link to="/mark-aqa-gcse-maths-past-papers" className="footer-link">AQA Maths Marking</Link>
                        <Link to="/mark-edexcel-gcse-maths-past-papers" className="footer-link">Edexcel Maths Marking</Link>
                        <Link to="/mark-ocr-gcse-maths-past-papers" className="footer-link">OCR Maths Marking</Link>
                        <Link to="/mark-aqa-gcse-english-language-past-papers" className="footer-link">AQA English Marking</Link>
                        <Link to="/exams/sqa-national-5" className="footer-link">SQA National 5</Link>
                    </div>

                    <div className="footer-column">
                        <span className="footer-label">International</span>
                        <Link to="/exams/cambridge-igcse" className="footer-link">Cambridge IGCSE</Link>
                        <Link to="/exams/international-a-level" className="footer-link">International A-Level (IAL)</Link>
                        <Link to="/exams/cambridge-o-level" className="footer-link">Cambridge O Level</Link>
                        <Link to="/exams/ib-diploma" className="footer-link">IB Diploma (HL/SL)</Link>
                        <Link to="/exams/ap-stem-frq" className="footer-link">AP® STEM FRQ</Link>
                    </div>

                    <div className="footer-column">
                        <span className="footer-label">Compare</span>
                        <Link to="/compare/vs-chatgpt" className="footer-link">VS ChatGPT</Link>
                        <Link to="/compare/vs-save-my-exams" className="footer-link">VS Save My Exams</Link>
                    </div>

                    <div className="footer-column">
                        <span className="footer-label">Company</span>
                        <Link to="/about" className="footer-link">About Us</Link>
                        <a href={getSupportMailto()} className="footer-link">Contact Support</a>
                        <Link to="/terms" className="footer-link">Terms</Link>
                        <Link to="/privacy" className="footer-link">Privacy</Link>
                    </div>
                </div>
            </div>
        </footer>
    );
};

export default LandingFooter;
